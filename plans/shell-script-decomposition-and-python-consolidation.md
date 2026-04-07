# Plan: Shell Script Decomposition and Server-Owned Coordination

The shell scripts in this repo have absorbed work that belongs in the coordination server: config parsing, JSON template generation, mutex polling, YAML frontmatter parsing, branch management, exit-log classification, team orchestration. `launch.sh` is 845 lines, `container/entrypoint.sh` is 967 lines, and `scaffold.config.json` is parsed independently by five scripts. One Python script in particular — `scripts/compile-agent.py` — is host-side build tooling that should be co-located with the rest of the server's TypeScript so it shares dependencies (`gray-matter`) with task ingestion and gets `node:test` coverage.

This plan moves coordination work into `server/src/` (TypeScript with `node:test` coverage), migrates the host-side agent compiler from Python to TypeScript, leaves the shell scripts doing only what shell is good at (`docker compose` invocation and host-side filesystem orchestration), and decomposes the remaining bash along the responsibility seams the audit identified.

**Container-side Python is intentionally preserved.** The container is a path-of-least-resistance sandbox for autonomous agents — Claude likes to use Python, and removing the runtime would be unnecessarily restrictive. Different languages on either side of the host/container scope boundary is acceptable. Specifically: `container/hooks/lint-cpp-diff.py`, `container/hooks/lint-cpp-diff.test.py`, `container/hooks/lint-fuzz-test.py`, and `container/patch_workspace.py` stay as-is. The container `Dockerfile` continues to install `python3`.

Final state:

- `launch.sh` ≤ 200 lines, dispatch only
- `container/entrypoint.sh` ≤ 200 lines, dispatch only
- `scripts/ingest-tasks.sh` is a 30-line curl shim
- `scripts/compile-agent.py` deleted; replaced by `server/src/agent-compiler.ts` and `npx compile-agent` CLI
- Container Python (lint hook + patch workspace) preserved untouched
- `scaffold.config.json` parsed in exactly one place (`server/src/config-resolver.ts`)
- Three claude-invocation paths in `entrypoint.sh` collapsed into one `_run_claude` helper
- Shared bash helpers in `scripts/lib/` and `container/lib/` consumed by every top-level script

---

## Phase 1: Shared bash libraries

Foundation phase — creates the helpers later phases will consume. No top-level scripts are modified yet.

**Files:**
- `scripts/lib/validators.sh` (new)
- `scripts/lib/compose-detect.sh` (new)
- `scripts/lib/curl-json.sh` (new)
- `scripts/lib/colors.sh` (new)
- `scripts/lib/test-libs.sh` (new — smoke tests)

**Work:**
1. Create `scripts/lib/validators.sh` exporting `_validate_identifier <label> <value>` (the `^[a-zA-Z0-9_-]+$` check currently duplicated in 5 scripts) and `_validate_branch_name <value>` (the regex from `launch.sh:270`).
2. Create `scripts/lib/compose-detect.sh` exporting `_detect_compose` that sets `COMPOSE_CMD` to `docker compose` or `docker-compose` and exits non-zero with a clear error if neither exists.
3. Create `scripts/lib/curl-json.sh` exporting `_post_json <url> <json_body>` and `_get_json <url>`. Both use `mktemp` + `jq` per the project's `feedback_shell_json_encoding.md` rule. Both return the response body on stdout and the HTTP status as exit code mapped to 0 on 2xx, non-zero otherwise.
4. Create `scripts/lib/colors.sh` containing the `C_RESET`/`C_BOLD`/etc. block currently inlined in `status.sh:82-106`, plus the `status_color` function.
5. Create `scripts/lib/test-libs.sh` that sources each lib and exercises every exported function with sample inputs. This is the regression test for these libs.
6. Add `scripts/lib/test-libs.sh` to the existing shell-syntax check (or the package.json test target) so CI runs it.

**Acceptance criteria:**
- `bash -n scripts/lib/*.sh` exits 0.
- `bash scripts/lib/test-libs.sh` exits 0 and prints PASS for every function.
- `_validate_identifier "test" "abc-123"` exits 0; `_validate_identifier "test" "bad name"` exits non-zero with the label in the error message.
- `_detect_compose` sets `COMPOSE_CMD` correctly on a host with `docker compose`.
- `_post_json` and `_get_json` round-trip JSON correctly against a local mock server (or `httpbin`).

---

## Phase 2: Config resolver — server module, endpoint, and shell adoption

Replaces five independent jq-based parsings of `scaffold.config.json` with one server endpoint. Migrates all five consumers in the same phase because the surface area is small per consumer and the change is mechanical.

**Files:**
- `server/src/config-resolver.ts` (new)
- `server/src/config-resolver.test.ts` (new)
- `server/src/routes/config.ts` (new)
- `server/src/server.ts` (modify — register route)
- `launch.sh` (modify — replace L160-205 with curl)
- `setup.sh` (modify — replace L175-198 multi-project iteration)
- `status.sh` (modify — replace L64-67 port lookup)
- `stop.sh` (modify — replace L78-82 port lookup)
- `scripts/ingest-tasks.sh` (modify — replace L42-46 port lookup)

**Work:**
1. Create `server/src/config-resolver.ts` exporting `resolveProjectConfig(projectId: string): ResolvedProjectConfig` and `listProjects(): string[]`. The resolver reads `scaffold.config.json`, synthesizes legacy single-project configs into the multi-project shape internally, validates the project id exists, and returns a fully-resolved object containing: `bareRepoPath`, `projectPath`, `engine.path`, `serverPort`, `build.scriptPath`, `build.testScriptPath`, `build.defaultTestFilters[]`, `logsPath`, `hooks.buildIntercept`, `hooks.cppLint`, `agentType`, `seedBranch`.
2. Define the `ResolvedProjectConfig` type alongside the function — exported.
3. Create `server/src/config-resolver.test.ts` with cases: legacy single-project config resolves under id `"default"`; multi-project config resolves under each declared id; missing project id throws with the available ids in the message; missing required fields throw with the field name; legacy and multi-project configs return the same shape for equivalent inputs.
4. Create `server/src/routes/config.ts` exposing `GET /config/:projectId` returning the resolved object as JSON, and `GET /config` returning `{ projects: string[] }` from `listProjects()`.
5. Register the new route file in `server/src/server.ts`.
6. Modify `launch.sh` to source `scripts/lib/curl-json.sh`, then replace lines 160-205 (both legacy and multi-project branches) with one `_get_json "http://localhost:${SERVER_PORT}/config/${PROJECT_ID}"` and `jq` over the response. The `SERVER_PORT` bootstrap (needed before the curl) reads from `.env` only.
7. Modify `setup.sh` to use `GET /config` for project enumeration and `GET /config/:id` for per-project fields. Delete the multi-project iteration block at L175-198 — it becomes a `for id in $(curl ... | jq -r '.projects[]')` loop.
8. Modify `status.sh`, `stop.sh`, and `scripts/ingest-tasks.sh` to source `curl-json.sh` and fetch the port via `_get_json`. Delete the inline jq port-reading from each.

**Acceptance criteria:**
- `npm test` in `server/` passes the new `config-resolver.test.ts`.
- `curl http://localhost:9100/config/default` returns the resolved JSON for a legacy config.
- `curl http://localhost:9100/config` returns `{ projects: ["default"] }` for a legacy config and the actual id list for a multi-project config.
- `./launch.sh --dry-run` produces the same resolved config output as before the change for both legacy and multi-project configs.
- `grep -rn "scaffold.config.json" *.sh scripts/*.sh` returns matches only in `setup.sh` (where it remains as the file the server reads) — no other shell script reads the file directly.

---

## Phase 3: Branch operations — server module, endpoints, and shell adoption

Moves all `git -C $BARE_REPO_PATH update-ref / rev-parse / branch` calls out of shell. Closes a latent race where two simultaneous launches could clobber the same branch ref.

**Files:**
- `server/src/branch-ops.ts` (new)
- `server/src/branch-ops.test.ts` (new)
- `server/src/routes/branch-ops.ts` (new)
- `server/src/server.ts` (modify — register route)
- `launch.sh` (modify — replace `_setup_branch` and team-mode SHA fetching)
- `setup.sh` (modify — replace `_create_bare_and_root` and `_init_bare_repo`)

**Work:**
1. Create `server/src/branch-ops.ts` exporting:
   - `ensureAgentBranch(projectId: string, agentName: string, fresh: boolean): { branch: string, sha: string, action: "created" | "reset" | "resumed" }`
   - `seedBranchSha(projectId: string): string`
   - `bootstrapBareRepo(projectId: string): { created: boolean, seedBranch: string }`
   - `migrateLegacySeedBranch(projectId: string): { migrated: boolean }`
2. All git calls go through `child_process.execFile("git", ["-C", bareRepoPath, ...args])` — no shell interpolation, no command injection surface.
3. Create `server/src/branch-ops.test.ts` covering: fresh-create on missing branch, fresh-reset on existing branch, resume on existing branch, missing seed branch error, legacy `docker/current-root` migration to `docker/{id}/current-root`, bootstrap creates the bare repo and seed branch from a project working tree.
4. Use `tmp` or `os.tmpdir()` in tests to create real bare repos so the git operations are exercised against actual git.
5. Create `server/src/routes/branch-ops.ts` exposing:
   - `POST /agents/:name/branch` body `{ projectId, fresh }` → returns the action object
   - `POST /projects/:id/seed:bootstrap` → returns the bootstrap result
6. Register the routes in `server/src/server.ts`.
7. Modify `launch.sh` — replace `_setup_branch` (L674-691) with `_post_json` to `/agents/:name/branch`. Replace the team-mode `git update-ref` block at L590-592 with the same call.
8. Modify `setup.sh` — replace `_create_bare_and_root` and `_init_bare_repo` with calls to `/projects/:id/seed:bootstrap`. Delete the legacy migration block at L153-164 — the server endpoint handles it.

**Acceptance criteria:**
- `npm test` passes the new `branch-ops.test.ts`.
- `./launch.sh --fresh --agent-name verify-1` creates `docker/{project}/verify-1` from the seed branch via the server.
- `./launch.sh --agent-name verify-1` (without `--fresh`) resumes the existing branch.
- `./setup.sh --non-interactive` against a project with no bare repo creates it and the seed branch via the server.
- `grep -n "git -C.*BARE_REPO_PATH" *.sh` returns no matches.

---

## Phase 4: Hook resolution — server module, endpoint, and shell adoption

Removes the duplicated hook cascade logic from `launch.sh` and `entrypoint.sh`. There is currently a 5-level cascade (system → project → team → member → CLI) implemented twice in two different shell dialects.

**Files:**
- `server/src/hook-resolution.ts` (new)
- `server/src/hook-resolution.test.ts` (new)
- `server/src/routes/hooks.ts` (new)
- `server/src/server.ts` (modify — register route)
- `launch.sh` (modify — replace `resolve_hooks` and `_resolve_hook_value`)
- `container/entrypoint.sh` (modify — replace access-scope-to-hook-flag block)

**Work:**
1. Create `server/src/hook-resolution.ts` exporting `resolveHooks(input: HookResolutionInput): { buildIntercept: boolean, cppLint: boolean, gitSync: boolean, workspaceReadonly: boolean }`. Input contains: `projectId`, optional `teamId`, optional `memberJson`, optional `cliBuild`, optional `cliLint`, optional `accessScope` (for the container-side resolution path).
2. Implement the cascade: system default → project → team → member → CLI override. The system default for `buildIntercept` is `true` if the project declares a build script, else `false`.
3. Implement the access-scope mapping currently in `entrypoint.sh:101-149`: `read-only` → `gitSync=false, workspaceReadonly=true`; `write-access` → `gitSync=true, workspaceReadonly=false`; `ubt-build-hook-interceptor` → `buildIntercept=true, gitSync=false, workspaceReadonly=false`.
4. Create `server/src/hook-resolution.test.ts` covering every override level individually, then combinations, then access-scope mapping, then access-scope + cascade together.
5. Create `server/src/routes/hooks.ts` exposing `POST /hooks/resolve` that accepts the input shape and returns the resolved flags.
6. Register the route.
7. Modify `launch.sh` — replace `resolve_hooks` and `_resolve_hook_value` (L320-367) and the validation helper with one `_post_json` call. Pass the team JSON path and member JSON inline.
8. Modify `container/entrypoint.sh` — replace L101-149 with one `_post_json` call passing the agent's `accessScope` from the meta sidecar. The container fetches its resolved hook flags from the same endpoint the launcher uses.

**Acceptance criteria:**
- `npm test` passes the new `hook-resolution.test.ts`.
- A `read-only` agent gets `buildIntercept=false, gitSync=false, workspaceReadonly=true` via the endpoint.
- A `write-access` agent with project `cppLint=true` gets `cppLint=true, gitSync=true`.
- CLI `--no-hooks` overrides all lower levels.
- `./launch.sh --dry-run` reports the same hook flags as before for every test combination.
- `grep -rn "_resolve_hook_value\|resolve_hooks" *.sh container/` returns no matches.

---

## Phase 5: Container settings and MCP rendering — server module and entrypoint adoption

Replaces the chained `jq -n --argjson` builders in `entrypoint.sh:151-188` and the MCP config heredoc at L355-384 with server-rendered files fetched at startup.

**Files:**
- `server/src/container-settings.ts` (new)
- `server/src/container-settings.test.ts` (new)
- `server/src/routes/container-settings.ts` (new)
- `server/src/server.ts` (modify — register route)
- `container/entrypoint.sh` (modify — replace settings.json + mcp.json generation)

**Work:**
1. Create `server/src/container-settings.ts` exporting:
   - `buildSettingsJson(opts: { buildIntercept: boolean, cppLint: boolean, gitSync: boolean, workspaceReadonly: boolean }): SettingsJson`
   - `buildMcpConfig(opts: { chatRoom?: string, serverUrl: string, agentName: string, sessionToken: string }): McpConfig`
2. The settings builder produces the exact same JSON shape the current `jq` chain produces — verify by snapshot test.
3. Create `server/src/container-settings.test.ts` covering all 16 combinations of the four boolean flags for settings, plus chat-room and solo modes for MCP.
4. Create `server/src/routes/container-settings.ts` exposing:
   - `GET /agents/:name/settings.json?build=...&lint=...&gitSync=...&readonly=...`
   - `GET /agents/:name/mcp.json?chatRoom=...&sessionToken=...`
5. Register the routes.
6. Modify `container/entrypoint.sh` — replace L151-188 with one curl that writes the response straight to `/home/claude/.claude/settings.json`. Replace L355-384 with one curl writing to `/home/claude/.claude/mcp.json`.

**Acceptance criteria:**
- `npm test` passes the new `container-settings.test.ts`.
- The rendered `settings.json` for every flag combination matches what the current `jq` chain would produce (snapshot test against current outputs captured before the refactor).
- A container started with `HOOK_BUILD_INTERCEPT=true HOOK_CPP_LINT=true` writes a `settings.json` containing both hook commands.
- A solo-mode container writes `mcp.json` with `mcpServers: {}`; a chat-mode container writes the chat MCP entry.
- `grep -n "jq -n.*argjson.*PRE_BASH\|MCPEOF" container/entrypoint.sh` returns no matches.

---

## Phase 6: Task ingest — server module and shell shim

Replaces the hand-rolled YAML frontmatter parser in `scripts/ingest-tasks.sh` with `gray-matter` server-side. The shell script becomes a 30-line curl wrapper.

**Files:**
- `server/package.json` (modify — add `gray-matter` dep)
- `server/src/task-ingest.ts` (new)
- `server/src/task-ingest.test.ts` (new)
- `server/src/routes/task-ingest.ts` (new)
- `server/src/server.ts` (modify — register route)
- `scripts/ingest-tasks.sh` (rewrite)

**Work:**
1. Add `gray-matter` to `server/package.json` dependencies. Run `npm install` in `server/`.
2. Create `server/src/task-ingest.ts` exporting:
   - `ingestTaskFile(filePath: string): { taskId: number, action: "created" | "skipped" }`
   - `ingestTaskDir(dirPath: string): { ingested: number, skipped: number, failures: Array<{ file: string, error: string }> }`
3. Use `gray-matter` for frontmatter parsing. Validate required fields (`title` falls back to filename), coerce priority to integer, parse `files:` as a YAML list (gray-matter handles this natively).
4. Deduplicate against the existing `tasks` table by `sourcePath` — query before insert. This replaces the `.ingest-state.json` file.
5. After ingestion, call the existing replan logic internally and return the count.
6. Create `server/src/task-ingest.test.ts` covering: title fallback, priority coercion, files-list parsing, dedup on re-ingest, malformed frontmatter (graceful failure), missing `tasksDir`, integration with replan.
7. Create `server/src/routes/task-ingest.ts` exposing `POST /tasks/ingest` body `{ tasksDir: string, dryRun?: boolean }` returning `{ ingested, skipped, replanned, failures }`.
8. Register the route.
9. Rewrite `scripts/ingest-tasks.sh` as a thin shim: parse `--tasks-dir`, `--server-url`, `--dry-run`, `--help`; source `scripts/lib/curl-json.sh`; `_post_json` to `/tasks/ingest`; print the response. Target is ≤ 60 lines.
10. Delete `parse_frontmatter` and the `.ingest-state.json` logic from the shell script.

**Acceptance criteria:**
- `npm test` passes the new `task-ingest.test.ts`.
- `./scripts/ingest-tasks.sh --tasks-dir tasks` against a fresh queue ingests every `.md` file with the same task IDs and field values as the previous shell parser.
- `./scripts/ingest-tasks.sh --tasks-dir tasks` run twice in a row reports `skipped` for every file on the second run.
- `./scripts/ingest-tasks.sh --dry-run` returns counts without inserting.
- `wc -l scripts/ingest-tasks.sh` reports ≤ 60 lines.

---

## Phase 7: TypeScript agent compiler — replaces compile-agent.py

Ports `scripts/compile-agent.py` to TypeScript so it can share `gray-matter` with the task ingest module and live alongside the rest of the testable server code.

**Files:**
- `server/src/agent-compiler.ts` (new)
- `server/src/agent-compiler.test.ts` (new)
- `server/src/bin/compile-agent.ts` (new)
- `server/package.json` (modify — add `bin` entry)
- `launch.sh` (modify — call node instead of python)
- `scripts/compile-agent.py` (delete)

**Work:**
1. Create `server/src/agent-compiler.ts` porting `compile-agent.py` rule-for-rule. Use `gray-matter` for the frontmatter parse (replaces the regex-based parser the Python script uses to avoid PyYAML). Use native `RegExp` for the `ACCESS SCOPE` extraction. Use `fs.promises` for I/O.
2. Preserve the access-scope ranking exactly: `read-only=0, write-access=1, ubt-build-hook-interceptor=2`. Highest rank wins when multiple skills declare scopes.
3. Preserve recursive sub-agent compilation: scan the lead agent's compiled skill content for references to other dynamic agents and compile those one level only. Sub-agents that reference further agents emit a warning, not recursion.
4. Create `server/src/agent-compiler.test.ts` covering: single-agent compile, recursive sub-agent discovery, access-scope ranking with multiple skills, missing skill error, output directory creation, access-scope sidecar `.meta.json` written correctly.
5. Use fixture agent files in `server/test/fixtures/dynamic-agents/` for the tests.
6. Create `server/src/bin/compile-agent.ts` as a CLI entry exposing the same flags as the Python script: `--all`, `--clean`, `-o <dir>`, `--recursive`, positional agent path.
7. Add `compile-agent` to the `bin` field in `server/package.json` so `npx compile-agent` resolves.
8. Modify `launch.sh:444-478` — replace `python "$SCRIPT_DIR/scripts/compile-agent.py" ...` with `node "$SCRIPT_DIR/server/dist/bin/compile-agent.js" ...` (or `npx tsx` during development). Document the build dependency.
9. Delete `scripts/compile-agent.py`.

**Acceptance criteria:**
- `npm test` passes the new `agent-compiler.test.ts`.
- `npx compile-agent --all -o /tmp/test-agents` produces byte-identical output to the Python compiler for every existing dynamic agent (snapshot test against pre-refactor outputs).
- `./launch.sh --agent-type container-orchestrator --dry-run` reports `AGENT_COMPILED: yes` and lists the same sub-agent candidates as before.
- `find . -name "compile-agent.py"` returns no matches.

---

## Phase 8: Exit classifier — server module and entrypoint adoption

Moves the abnormal-exit pattern matching out of `entrypoint.sh` so failure classification is centrally defined and unit-tested with fixture logs.

**Files:**
- `server/src/exit-classifier.ts` (new)
- `server/src/exit-classifier.test.ts` (new)
- `server/src/routes/exit-classifier.ts` (new)
- `server/src/server.ts` (modify — register route)
- `container/entrypoint.sh` (modify — replace `_detect_abnormal_exit`)

**Work:**
1. Create `server/src/exit-classifier.ts` exporting `classifyExit(opts: { logTail: string, elapsedSeconds: number, outputLineCount: number }): { abnormal: boolean, reason: string | null }`.
2. Port the regex heuristics from `container/entrypoint.sh:212-245`: auth failure patterns, token/rate/quota exhaustion patterns, the rapid-exit heuristic (< 10 seconds AND < 5 output lines).
3. Create `server/src/exit-classifier.test.ts` with fixture log strings covering: auth failure, token exhaustion, rate limit, billing error, rapid exit, clean exit. Each fixture asserts the expected `reason` string.
4. Create `server/src/routes/exit-classifier.ts` exposing `POST /agents/:name/exit:classify` body `{ logTail, elapsedSeconds, outputLineCount }`.
5. Register the route.
6. Modify `container/entrypoint.sh` — replace `_detect_abnormal_exit` (L212-245) with a function that posts the last 200 lines of `$CLAUDE_OUTPUT_LOG` plus the elapsed seconds plus the output line count to the endpoint, and reads `.abnormal` and `.reason` from the response. Set `ABNORMAL_REASON` from the response.

**Acceptance criteria:**
- `npm test` passes the new `exit-classifier.test.ts`.
- A container whose Claude output contains `Failed to authenticate` is classified `abnormal: true, reason: "authentication failure (...)"`.
- A clean exit is classified `abnormal: false, reason: null`.
- The pump-loop circuit breaker still trips after two consecutive abnormal exits (existing behavior preserved).
- `grep -n "authentication_error\|token.*limit" container/entrypoint.sh` returns no matches.

---

## Phase 9: Team launcher — server module and launch.sh team-mode replacement

Moves the 165-line team-launch block out of `launch.sh` into a server endpoint plus a thin caller script.

**Files:**
- `server/src/team-launcher.ts` (new)
- `server/src/team-launcher.test.ts` (new)
- `server/src/routes/team-launcher.ts` (new)
- `server/src/server.ts` (modify — register route)
- `scripts/launch-team.sh` (new)
- `launch.sh` (modify — exec launch-team.sh when --team is set)

**Work:**
1. Create `server/src/team-launcher.ts` exporting `launchTeam(opts: { projectId: string, teamId: string, briefPath: string }): TeamLaunchPlan` where `TeamLaunchPlan` is `{ roomId: string, brief: { path: string, posted: boolean }, members: Array<{ agentName: string, agentType: string, branch: string, role: string, isLeader: boolean, hooks: { buildIntercept, cppLint, gitSync, workspaceReadonly }, env: Record<string, string> }> }`.
2. The function: validates the brief exists on the seed branch (via existing git operations), reads the team JSON, registers the team and creates the room, posts the brief message to the room, sets every member's branch ref to seed branch HEAD, resolves each member's hook cascade, and returns the launch plan with all the env each container needs.
3. Validate every team member field server-side (agentName, agentType, role) using the same regex the shell currently uses.
4. Create `server/src/team-launcher.test.ts` covering: happy path with one leader and two members, missing brief on seed branch, missing team file, duplicate member name, member with invalid agentName format, hook cascade applied per member.
5. Create `server/src/routes/team-launcher.ts` exposing `POST /teams/:id/launch` body `{ projectId, briefPath }` returning the launch plan.
6. Register the route.
7. Create `scripts/launch-team.sh` that: parses `--team`, `--brief`, `--project`; sources `scripts/lib/curl-json.sh`; calls `POST /teams/:id/launch`; iterates `members[]` from the response and runs `_launch_container` (sourced from `scripts/lib/launch-container.sh` once that exists in Phase 13 — for now inline the docker compose call) with the env from each member.
8. Modify `launch.sh` — when `--team` is set, exec `scripts/launch-team.sh` and exit. Delete the team-mode block at L480-646 from `launch.sh`.

**Acceptance criteria:**
- `npm test` passes the new `team-launcher.test.ts`.
- `./launch.sh --team test-team --brief Notes/test-brief.md` registers the team, creates the room, posts the brief message, and launches every member container.
- The leader is launched first, then a 10-second pause, then the others (current behavior preserved).
- A team launch with a missing brief fails with the same error message as before.
- `wc -l launch.sh` reports a smaller line count by ~165.

---

## Phase 10: Decompose entrypoint.sh into container/lib/

Extracts helpers along the section seams in `entrypoint.sh` and collapses the three near-identical claude invocation paths into one helper. After this phase `entrypoint.sh` is a flat dispatcher.

**Files:**
- `container/lib/env.sh` (new)
- `container/lib/workspace-setup.sh` (new)
- `container/lib/registration.sh` (new)
- `container/lib/finalize.sh` (new)
- `container/lib/run-claude.sh` (new)
- `container/lib/pump-loop.sh` (new)
- `container/entrypoint.sh` (rewrite as dispatcher)
- `container/Dockerfile` (modify — copy lib files into image)

**Work:**
1. Create `container/lib/env.sh` containing the env-var defaulting and validation block from `entrypoint.sh:1-22` plus the persistent log tee setup from L23-31.
2. Create `container/lib/workspace-setup.sh` containing the clone/checkout/exclude block from L40-69, the agent-snapshot block from L71-94, and the inlined plugin-symlink loop added in Phase 9. Export as one function `_setup_workspace`.
3. Create `container/lib/registration.sh` containing `_curl_server`, `_post_status`, `_post_abnormal_shutdown_message`, `_shutdown`, `_watch_for_stop`, and the registration + smoke-test sequence. The settings.json and mcp.json fetches (added in Phase 5) live here too.
4. Create `container/lib/finalize.sh` containing one function `_finalize_workspace` that does: `git add -A`, `git commit` if dirty, `git push --force`, and the diff stats logging block. This collapses the three duplicated copies at L283-289, L658-674, L803-818.
5. Create `container/lib/run-claude.sh` containing `_run_claude <prompt> <mode>` where mode is `task | chat | direct`. Body: `_post_status working`, capture output to `$CLAUDE_OUTPUT_LOG`, spawn watchdog, wait, classify exit via the server endpoint from Phase 8, return exit code. This collapses `run_claude_task`, `run_chat_agent`, and the direct-prompt block into one function.
6. Create `container/lib/pump-loop.sh` containing `_pump_iteration` returning a status enum (`continue | paused | stop | circuit_break`) via stdout. The outer pump loop in the new `entrypoint.sh` is a flat dispatcher that reads the enum and acts.
7. Rewrite `container/entrypoint.sh` as a dispatcher: source the lib files, run `_setup_workspace`, register, fetch settings/mcp, dispatch on `WORKER_MODE` and `CHAT_ROOM` and `DIRECT_PROMPT` to the right `_run_claude` mode (or pump loop), then `_finalize_workspace`.
8. Modify `container/Dockerfile` to copy `container/lib/` into the image at `/container-lib/` (or wherever entrypoint.sh sources from).

**Acceptance criteria:**
- `wc -l container/entrypoint.sh` reports ≤ 200 lines.
- `bash -n container/entrypoint.sh` and `bash -n container/lib/*.sh` exit 0.
- A worker-mode container runs through one task identically to before (verified by comparing log output for the same task).
- A chat-mode container joins a room and posts messages identically to before.
- A direct-prompt container runs and exits identically to before.
- The pump loop trips the circuit breaker after two consecutive abnormal exits (preserved from Phase 8).
- `grep -c "claude.*-p.*FULL_PROMPT\|claude.*-p.*DIRECT_PROMPT" container/entrypoint.sh container/lib/*.sh` returns 1 (only inside `_run_claude`).

---

## Phase 11: Decompose launch.sh and replace docker-compose heredoc with static templates

Extracts helpers from `launch.sh` and replaces the inline `_generate_compose` heredoc with static compose files using Compose's native multi-file overlay mechanism.

**Files:**
- `scripts/lib/parse-launch-args.sh` (new)
- `scripts/lib/launch-container.sh` (new)
- `scripts/lib/print-resolved-config.sh` (new)
- `container/docker-compose.template.yml` (new — static base)
- `container/docker-compose.engine.yml` (new — engine overlay)
- `launch.sh` (rewrite as dispatcher)
- `container/docker-compose.example.yml` (delete or update)

**Work:**
1. Create `scripts/lib/parse-launch-args.sh` containing the CLI parser block from `launch.sh:49-115`. Exports the `_CLI_*` variables.
2. Create `scripts/lib/launch-container.sh` containing `_launch_container <agent_name> [ENV_OVERRIDES...]` (currently L373-382) and `_compose_project_name <agent>` returning `claude-${PROJECT_ID}-${agent}`.
3. Create `scripts/lib/print-resolved-config.sh` containing the dry-run pretty-printer from L384-442, exported as `_print_resolved_config`. Call it from both the dry-run path and the actual launch path so users always see what was resolved at launch.
4. Create `container/docker-compose.template.yml` as the static base — every service definition that doesn't depend on optional volumes. Use Compose's `${VAR:?}` and `${VAR:-default}` interpolation for env vars (Compose handles this natively).
5. Create `container/docker-compose.engine.yml` as an overlay containing only the engine volume mount.
6. In `_launch_container`, when `UE_ENGINE_PATH` is set, invoke `docker compose -f docker-compose.template.yml -f docker-compose.engine.yml ...`. Otherwise just `-f docker-compose.template.yml`.
7. Delete `_generate_compose` and the inline heredoc from `launch.sh` entirely.
8. Rewrite `launch.sh` as a flat dispatcher: source libs, parse args, fetch resolved config from `/config/:projectId`, fetch resolved hooks from `/hooks/resolve`, ensure branch via `/agents/:name/branch`, call `_print_resolved_config`, dispatch on `--team` (exec `scripts/launch-team.sh`) or `--parallel` or single-agent. Run `_launch_container` once or in a loop.

**Acceptance criteria:**
- `wc -l launch.sh` reports ≤ 200 lines.
- `bash -n launch.sh` and `bash -n scripts/lib/*.sh` exit 0.
- `./launch.sh --dry-run` against a single-project config produces resolved-config output identical to before the refactor.
- `./launch.sh --worker --agent-name verify-13` launches a single agent identically to before.
- `./launch.sh --parallel 3` launches three agents identically to before.
- A project without `UE_ENGINE_PATH` set launches without the engine volume; one with it set has the engine mounted read-only.
- `grep -n "_generate_compose\|COMPOSEOF" launch.sh` returns no matches.

---

## Phase 12: Fix and decompose stop.sh

Fixes two latent bugs surfaced by the audit and extracts the duplicated signal-and-stop logic into a helper.

**Files:**
- `scripts/lib/stop-helpers.sh` (new)
- `stop.sh` (modify — fix bugs, extract helpers)

**Work:**
1. Fix the `local` outside-function bug at `stop.sh:184-185` — wrap the `MODE == "agent"` block in a function so `local` is valid, or remove the `local` keywords. Verify with `bash -n` and a real run.
2. Fix the inconsistent compose-project naming at `stop.sh:218-219` — the team-mode block currently uses `claude-${member}` but `launch.sh` always names projects `claude-${PROJECT_ID}-${AGENT_NAME}`. Update the team-mode block to use the same `claude-${PROJECT_ID}-${member}` convention.
3. Create `scripts/lib/stop-helpers.sh` exporting:
   - `_signal_stop <agent_name>` (the curl DELETE block from L105-108)
   - `_signal_and_stop_projects <project_names...>` that signals every agent then runs `docker compose down` for each project
   - `_list_claude_projects [project_id_filter]` that returns the list of running compose projects, optionally filtered by project id
4. Modify `stop.sh` — source the helper, replace the four mode-specific stop loops with calls to `_signal_and_stop_projects`. The drain mode still polls `/coalesce/status` but defers the actual stop to the helper.
5. Verify the team mode now correctly finds and stops containers launched by the current `launch.sh`.

**Acceptance criteria:**
- `bash -n stop.sh` exits 0.
- `./stop.sh` (default mode) stops all running `claude-*` containers.
- `./stop.sh --agent verify-14 --project default` stops only that agent.
- `./stop.sh --team test-team` stops every member of the team — the compose project naming bug is verified fixed by launching a team in Phase 9 then stopping it here.
- `./stop.sh --drain` runs the drain protocol then stops cleanly.
- `wc -l stop.sh` reports a smaller line count by ~50.

---

## Phase 13: Server merged status endpoint and status.sh rewrite

Replaces the three independent curl calls in `status.sh` with one merged server response. Collapses the duplicated printf table branches.

**Files:**
- `server/src/routes/status.ts` (new)
- `server/src/server.ts` (modify — register route)
- `status.sh` (rewrite)

**Work:**
1. Create `server/src/routes/status.ts` exposing `GET /status?project=:id` returning `{ agents: Agent[], tasks: Task[], messages: Message[] }`. Internally calls the existing list functions for agents, tasks (with limit 20), and messages (since cursor).
2. Accept an optional `?since=N` query for the message cursor.
3. Register the route.
4. Rewrite `status.sh` to fetch one URL, parse the merged JSON, and render. Source `scripts/lib/colors.sh` for color helpers.
5. Collapse the duplicated agent table branches (with-project vs without-project at L129-145) — compute the column list once based on whether `--project` was passed.
6. Collapse the duplicated tasks table branches (L164-191) the same way.
7. Extract `_print_agent_row` and `_print_task_row` so the printf logic isn't repeated.

**Acceptance criteria:**
- `curl http://localhost:9100/status` returns the merged shape.
- `./status.sh` produces the same visual output as before for both single-project and multi-project configs.
- `./status.sh --follow` refreshes correctly and updates the message cursor.
- `wc -l status.sh` reports a smaller line count by ~50.
- `grep -c "curl.*BASE_URL" status.sh` returns 1 (only the merged status fetch).

---

## Phase 14: Documentation update and final verification

Updates `CLAUDE.md` to reflect the new architecture, then runs end-to-end verification of every changed surface.

**Files:**
- `CLAUDE.md` (modify — update Architecture section)
- `README.md` (modify — only if it currently lists `python` as a host-side prerequisite for `compile-agent.py`)
- `setup.sh` (modify — only if it currently runs `check_tool "Python" ...` for the host)

**Work:**
1. Update `CLAUDE.md` Architecture section to state: server owns config resolution, branch ops, hook cascade, container settings rendering, exit classification, team launch, task ingest, and agent compilation. Shell scripts dispatch only.
2. Update `CLAUDE.md` Commands section to reflect that agent compilation now uses `npx compile-agent` instead of `python scripts/compile-agent.py`.
3. Note in `CLAUDE.md` that container-side Python (`lint-cpp-diff.py`, `patch_workspace.py`) is intentionally preserved — the container ships `python3` so agents have it available during their work.
4. If `README.md` lists Python as a *host-side* prerequisite (for `compile-agent.py`), remove it. Do not touch any container-side Python references.
5. If `setup.sh` runs a host-side Python prereq check, remove it. Do not touch container Dockerfile.
6. Run end-to-end verification:
   - `npm test` in `server/` — every new module passes.
   - `bash -n` over every shell script in the repo.
   - `./launch.sh --worker --agent-name verify-final` against a test project; container reaches polling loop and registers.
   - `./launch.sh --parallel 2`; both agents start cleanly.
   - `./launch.sh --team test-team --brief Notes/test-brief.md`; team room created, brief posted, members launched.
   - `./stop.sh --drain`; drain runs and stops cleanly.
   - `./scripts/ingest-tasks.sh --tasks-dir tasks --dry-run` then for real; tasks land in the queue with correct frontmatter parsing.
   - Inside a running container, edit a `.h` file with an east-const violation; the existing Python lint hook still blocks with the correct message.
   - `docker run --rm <container-image> which python3` returns a path (preserved on purpose).
   - `find . -name "compile-agent.py"` returns no matches.

**Acceptance criteria:**
- All shell scripts pass `bash -n`.
- All server tests pass.
- Every end-to-end verification command above succeeds.
- The container image still contains `python3` and the lint hook still works.
- `wc -l launch.sh container/entrypoint.sh` reports both ≤ 200 lines.

---

## Out of scope

These items were considered during the audit but deliberately left out:

- **Container-side Python.** `container/hooks/lint-cpp-diff.py`, its tests, `container/hooks/lint-fuzz-test.py`, and `container/patch_workspace.py` stay as-is. The container is a sandbox for autonomous agents and Python is a useful runtime to have available — removing it would be unnecessarily restrictive. The host/container scope boundary is the right place to draw the language line.
- **Refactoring `container/hooks/intercept_build_test.sh`.** The audit flagged the UBT lock polling loop as movable into a server long-poll endpoint. That touches the build/test critical path and deserves its own plan with careful migration steps and rollback safety.
- **Dashboard changes.** The new `/config` and `/status` endpoints are additive and don't break the dashboard. Replacing the dashboard's three independent fetches with one `/status` call is a separate UX cleanup.
- **Changing agent definition format or dynamic-agent compilation semantics.** The TS compiler in Phase 7 must produce byte-identical output to the Python compiler for the same inputs.
- **Replacing the manual `--force` pushes in `entrypoint.sh` finalize blocks with a safer push mode.** This is a behavioral change with branch-safety implications and warrants its own discussion.
