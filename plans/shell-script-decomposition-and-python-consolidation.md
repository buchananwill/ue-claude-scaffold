# Shell Script Decomposition and Python Consolidation

## Why

The shell scripts in this repo have absorbed work that belongs in the coordination server: config parsing, JSON template generation, mutex polling, YAML frontmatter parsing, branch management, exit-log classification, team orchestration. `launch.sh` is 845 lines, `container/entrypoint.sh` is 967, and the same `scaffold.config.json` is parsed independently by five scripts. The Python scripts (`compile-agent.py`, `lint-cpp-diff.py`, `patch_workspace.py`) duplicate the multi-language tooling story for no language-specific benefit.

This plan moves coordination work into `server/src/` (TypeScript with `node:test` coverage), drops Python from the project, leaves the shell scripts doing only what shell is good at — `docker compose` invocation and host-side filesystem orchestration — and decomposes the remaining bash along the responsibility seams the audit identified.

## Outcome

- `launch.sh` ≤ 200 lines, dispatch only
- `container/entrypoint.sh` ≤ 200 lines, dispatch only
- `scripts/ingest-tasks.sh` deleted; replaced by `curl POST /tasks/ingest`
- `scripts/compile-agent.py` deleted; replaced by `server/src/agent-compiler.ts`
- `container/hooks/lint-cpp-diff.py` deleted; replaced by `container/hooks/lint-cpp-diff.mjs`
- `container/patch_workspace.py` deleted; replaced by 5-line shell snippet
- Python removed from the container image entirely
- `scaffold.config.json` parsed in exactly one place (`server/src/config-resolver.ts`), exposed via `GET /config/:projectId`
- All hook policy resolution lives in `server/src/hook-resolution.ts` with unit tests
- All bare-repo branch mutation lives in `server/src/branch-ops.ts` exposed via REST
- Three claude-invocation paths in `entrypoint.sh` collapsed into one `_run_claude` helper
- Shared bash helpers in `scripts/lib/` consumed by every top-level script

## Steps

### Foundations

1. Create `scripts/lib/` directory.
2. Write `scripts/lib/validators.sh` exporting `_validate_identifier <label> <value>` (the `^[a-zA-Z0-9_-]+$` check used in 5 places) and `_validate_branch_name <value>`.
3. Write `scripts/lib/compose-detect.sh` exporting `_detect_compose` that sets `COMPOSE_CMD` to `docker compose` or `docker-compose` and exits with an error if neither exists.
4. Write `scripts/lib/curl-json.sh` exporting `_post_json <url> <body_json>` and `_get_json <url>`. Both use `mktemp` + `jq` per the project's `feedback_shell_json_encoding.md` rule.
5. Write `scripts/lib/colors.sh` extracted from `status.sh` lines 82–106.
6. Add `bash -n` smoke checks for every new lib file to `package.json` test script in the repo root (or wherever the existing shell-syntax check lives).

### Server-side config resolver

7. Create `server/src/config-resolver.ts` with one exported function `resolveProjectConfig(projectId: string): ResolvedProjectConfig`. It reads `scaffold.config.json` once, synthesizes legacy single-project configs into the multi-project shape, validates the project id exists, and returns a fully resolved object (paths, ports, build script names, default test filters, hook defaults, seed branch, agent type).
8. Add `server/src/config-resolver.test.ts` covering: legacy config, multi-project config, missing project id, missing engine path, malformed json.
9. Add route `GET /config/:projectId` in `server/src/routes/config.ts` returning the resolved config as JSON.
10. Register the new route in `server/src/server.ts`.
11. Replace the per-project field lookups in `launch.sh:164-205` with one `curl` to `/config/:projectId` and one `jq` over the response.
12. Replace the port-only lookups in `status.sh:64-67`, `stop.sh:78-82`, and `scripts/ingest-tasks.sh:42-46` with the same call.
13. Replace the multi-project iteration block in `setup.sh:175-199` with a call to `GET /config` (new index endpoint listing all project ids) — add that endpoint.
14. Delete the inline jq config-reading from all five scripts.

### Server-side branch operations

15. Create `server/src/branch-ops.ts` with functions `ensureAgentBranch(projectId, agentName, fresh: boolean)`, `seedBranchSha(projectId)`, `migrateLegacySeedBranch(projectId)`. All use `git -C bareRepoPath ...` via `child_process.execFile` with proper argument arrays (no shell interpolation).
16. Add `server/src/branch-ops.test.ts` covering: fresh-create, resume-existing, fresh-reset, migration from `docker/current-root`, missing seed branch.
17. Add route `POST /agents/:name/branch` accepting `{fresh: boolean}` and returning `{branch, sha, action: "created"|"reset"|"resumed"}`.
18. Add route `POST /projects/:id/seed:bootstrap` for the setup-time bare-repo creation (clone-bare + initial seed branch).
19. Replace `launch.sh:_setup_branch` (L674–691) with one curl to `POST /agents/:name/branch`.
20. Replace `launch.sh:590-592` (team-mode branch reset) with the same call.
21. Replace `setup.sh:_create_bare_and_root` and `setup.sh:_init_bare_repo` with one curl to `POST /projects/:id/seed:bootstrap`.
22. Delete the legacy seed-branch migration block from `setup.sh:153-164`.

### Server-side hook resolution

23. Create `server/src/hook-resolution.ts` with `resolveHooks(input: { projectId, teamId?, memberJson?, cliBuild?, cliLint? }): { buildIntercept, cppLint }`. Implements the 5-level cascade: system default → project → team → member → CLI.
24. Add `server/src/hook-resolution.test.ts` covering every combination of override levels.
25. Add route `POST /hooks/resolve` accepting the cascade input and returning the resolved flags.
26. Replace `launch.sh:resolve_hooks` and `_resolve_hook_value` (L320–367) with one curl to `/hooks/resolve`.
27. Delete the duplicated access-scope-to-hook-flag derivation from `container/entrypoint.sh:101-149` — the container fetches its resolved hook flags from the same endpoint at startup.

### Server-side container settings rendering

28. Create `server/src/container-settings.ts` exporting `buildSettingsJson(opts: { buildIntercept, cppLint, gitSync, workspaceReadonly })` returning the Claude `settings.json` object.
29. Add `server/src/container-settings.test.ts` covering all 8 combinations of the four flags.
30. Add route `GET /agents/:name/settings.json?build=...&lint=...&gitSync=...` returning the rendered JSON.
31. Replace `entrypoint.sh:151-188` (the chained `jq -n --argjson` builders) with one curl that writes the response straight to `/home/claude/.claude/settings.json`.
32. Repeat for the MCP config: add `GET /agents/:name/mcp.json?chatRoom=...` and replace `entrypoint.sh:355-384`.

### Server-side task ingest

33. Add `gray-matter` to `server/package.json`.
34. Create `server/src/task-ingest.ts` exporting `ingestTaskFile(filePath: string)` and `ingestTaskDir(dirPath: string)`. Uses `gray-matter` to parse frontmatter, validates required fields, deduplicates against the existing tasks table by `sourcePath`.
35. Add `server/src/task-ingest.test.ts` covering: title fallback to filename, priority validation, files-list parsing, dedup on re-ingest, malformed frontmatter.
36. Add route `POST /tasks/ingest` accepting `{tasksDir: string}` and returning `{ingested: number, skipped: number, replanned: number}`. Calls existing replan logic internally.
37. Rewrite `scripts/ingest-tasks.sh` as a 30-line shim: parse `--tasks-dir`, `--server-url`, `--dry-run`, `--help`, then `curl POST /tasks/ingest`.
38. Delete `parse_frontmatter` and the entire state-file logic from the shell script.

### Server-side agent compiler (replaces compile-agent.py)

39. Create `server/src/agent-compiler.ts` porting `scripts/compile-agent.py` line-for-line. Uses `gray-matter` for the frontmatter parse, native `RegExp` for the access-scope rank, `fs.promises` for I/O.
40. Add `server/src/agent-compiler.test.ts` covering: single-agent compile, recursive sub-agent discovery, access-scope ranking precedence, missing skill error.
41. Add a CLI entry `server/src/bin/compile-agent.ts` that exposes the same flags as `compile-agent.py` (`--all`, `--clean`, `-o`, `--recursive`).
42. Add `compile-agent` to the `bin` field in `server/package.json` so `npx compile-agent` works.
43. Replace `launch.sh:444-478` to call `node server/dist/bin/compile-agent.js` (or `npx tsx`) instead of `python scripts/compile-agent.py`.
44. Delete `scripts/compile-agent.py`.

### Container-side cpp lint (replaces lint-cpp-diff.py)

45. Create `container/hooks/lint-cpp-diff.mjs` porting `lint-cpp-diff.py` rule-for-rule. Reads JSON from stdin, exits 0 on clean and 2 + stdout on issues.
46. Create `container/hooks/lint-cpp-diff.test.mjs` covering the same rule fixtures the Python test covers.
47. Run `node:test` on the new file to confirm parity.
48. Update `entrypoint.sh:170` to point at `node /claude-hooks/lint-cpp-diff.mjs` instead of `python3 /claude-hooks/lint-cpp-diff.py`.
49. Delete `container/hooks/lint-cpp-diff.py`, `container/hooks/lint-cpp-diff.test.py`, `container/hooks/lint-fuzz-test.py`.

### Container-side workspace patching (replaces patch_workspace.py)

50. Replace `container/patch_workspace.py` with 5 lines of bash inlined into `entrypoint.sh` after the workspace clone: iterate `/plugins-ro/*`, `ln -sfn` each into `/workspace/Plugins/`.
51. Delete `container/patch_workspace.py`.
52. Remove the `python3` package install from `container/Dockerfile` (verify nothing else in the image needs it first).

### Server-side abnormal exit classification

53. Create `server/src/exit-classifier.ts` exporting `classifyExit(opts: { logTail: string, elapsedSeconds: number, outputLineCount: number })` returning `{abnormal: boolean, reason: string|null}`. Ports the regex heuristics from `entrypoint.sh:212-245`.
54. Add `server/src/exit-classifier.test.ts` with fixture logs covering: auth failure, token exhaustion, rapid exit, clean exit.
55. Add route `POST /agents/:name/exit:classify` accepting `{logTail, elapsedSeconds, outputLineCount}`.
56. Replace `_detect_abnormal_exit` in `entrypoint.sh` with a curl that posts the last 200 lines of `$CLAUDE_OUTPUT_LOG` and reads `.abnormal` / `.reason` from the response.

### Server-side team launch

57. Create `server/src/team-launcher.ts` exporting `launchTeam(opts: { projectId, teamId, briefPath })`. Validates the brief exists on the seed branch, registers the team, posts the brief message to the room, sets all member branch refs, and returns `{roomId, members: Array<{agentName, agentType, branch, role, hooks, env}>}`.
58. Add `server/src/team-launcher.test.ts` covering happy path, missing brief, missing team file, duplicate member.
59. Add route `POST /teams/:id/launch` accepting `{projectId, briefPath}` and returning the launch plan.
60. Rewrite `launch.sh:480-646` as a thin caller: curl `POST /teams/:id/launch`, then for each member in the response run `_launch_container` with the env from the response.
61. Move the rewritten team block out of `launch.sh` into `scripts/launch-team.sh`. `launch.sh` execs it when `--team` is set.

### Decompose entrypoint.sh

62. Create `container/lib/env.sh` containing the env-var defaulting and validation block from `entrypoint.sh:1-22`.
63. Create `container/lib/workspace-setup.sh` containing the clone/checkout/exclude block from `entrypoint.sh:40-69` plus the agent-snapshot block from L71-94 plus the inlined plugin-symlink loop from step 50.
64. Create `container/lib/registration.sh` containing `_curl_server`, `_post_status`, `_post_abnormal_shutdown_message`, `_shutdown`, `_watch_for_stop`, and the registration + smoke-test sequence.
65. Create `container/lib/finalize.sh` containing the final-commit-and-push block (currently duplicated at L283-289, L658-674, L803-818). Export as `_finalize_workspace`.
66. Create `container/lib/run-claude.sh` containing one function `_run_claude <prompt> <mode>` where mode is `task|chat|direct`. Body: `_post_status working`, capture output to `$CLAUDE_OUTPUT_LOG`, spawn watchdog, wait, classify exit via the new server endpoint, return exit code. This collapses `run_claude_task`, `run_chat_agent`, and the direct-prompt block into one helper.
67. Rewrite `entrypoint.sh` as a flat dispatcher: source the lib files, fetch settings.json and mcp.json from the server, call `_run_claude` with the right mode, finalize.
68. Extract the pump loop from `entrypoint.sh:895-962` into `container/lib/pump-loop.sh` exporting `_pump_iteration` returning a status enum (`continue|paused|stop|circuit_break`). The outer loop becomes a flat dispatcher.
69. Verify final `entrypoint.sh` is ≤ 200 lines.

### Decompose launch.sh

70. Create `scripts/lib/parse-launch-args.sh` containing the CLI parser block from `launch.sh:49-115`.
71. Create `scripts/lib/launch-container.sh` containing `_launch_container` (currently L373-382) and the compose-project naming helper.
72. Move the dry-run pretty-printer from `launch.sh:384-442` into `scripts/lib/print-resolved-config.sh`. Call it from both the dry-run path and the actual launch path so users always see what was resolved.
73. Replace the inline `_generate_compose` heredoc (L719-774) with a static `container/docker-compose.template.yml` plus a `container/docker-compose.engine.yml` overlay. Use `docker compose -f base -f engine` when `UE_ENGINE_PATH` is set. Delete `_generate_compose` entirely.
74. Rewrite `launch.sh` as a flat dispatcher: source libs, parse args, fetch resolved config from server, fetch resolved hooks from server, ensure branch via server, generate nothing, run `_launch_container`. Verify final `launch.sh` is ≤ 200 lines.

### Fix and decompose stop.sh

75. Fix the `local` outside-function bug at `stop.sh:184-185` — wrap the agent-mode block in a function or remove the `local` keywords.
76. Fix the inconsistent compose-project naming in the team-mode block at `stop.sh:218-219` — must match `launch.sh`'s `claude-${PROJECT_ID}-${AGENT_NAME}` convention. Currently it uses `claude-${member}` which won't match anything launched after the multi-project change.
77. Extract `_signal_and_stop_projects <project_names...>` into `scripts/lib/stop-helpers.sh`. Use it from all four modes.
78. Replace the drain-mode polling loop (L237-298) with a call to `POST /coalesce/drain` accepting `{timeout, projectId?}` — the server runs the state machine and streams progress lines back.

### Decompose status.sh

79. Add route `GET /status?project=:id` in the server returning a single merged JSON: `{agents, tasks, messages}` with all the fields the script needs.
80. Rewrite `status.sh` to fetch one URL and render — drop the three independent curl calls.
81. Extract `_print_agent_row` and `_print_task_row` so the with-project and without-project printf branches collapse to one column-list lookup.

### Container image cleanup

82. Remove `python3` from `container/Dockerfile` apt-install line.
83. Verify `node` and `npm` are present (Claude Code CLI install ensures this).
84. Add `node container/hooks/lint-cpp-diff.mjs` to the smoke-test step of the Dockerfile if such a step exists.
85. Rebuild the container image and run an end-to-end launch to confirm nothing referenced Python.

### Verification

86. Run `npm test` in `server/` — every new module has tests, all must pass.
87. Run `bash -n` over every shell script in the repo — syntax check.
88. Launch a single agent via `./launch.sh --worker --agent-name verify-1` against a test project; confirm the container reaches the polling loop and registers cleanly.
89. Launch a parallel run via `./launch.sh --parallel 2`; confirm both agents start and use server-resolved branches.
90. Launch a team via `./launch.sh --team test-team --brief Notes/test-brief.md`; confirm the room is created server-side and the brief is posted.
91. Stop everything via `./stop.sh --drain`; confirm the server's drain endpoint runs the state machine and the script exits cleanly.
92. Run `./scripts/ingest-tasks.sh --tasks-dir tasks --dry-run` then for real; confirm tasks land in the queue with correct frontmatter parsing via gray-matter.
93. Trigger a build hook from inside a container; confirm `intercept_build_test.sh` still works (it was not refactored in this plan — that's a follow-up).
94. Trigger an Edit on a `.h` file with an east-const violation; confirm `lint-cpp-diff.mjs` blocks it with the same message format the Python version produced.
95. Confirm the container image no longer contains `/usr/bin/python3` (`docker run --rm <image> which python3` returns empty).
96. Update `CLAUDE.md` "Architecture" section to reflect: server owns config resolution, branch ops, hook cascade, settings rendering, exit classification, team launch, task ingest, agent compilation, cpp lint. Shell scripts dispatch only.
97. Update `README.md` if it documents Python prerequisites — remove them.
98. Delete this plan file once all steps land in `main`.

## What is explicitly out of scope

- Refactoring `container/hooks/intercept_build_test.sh`. The audit flagged the UBT lock polling loop as movable into a server long-poll endpoint, but that touches the build/test critical path and deserves its own plan with more careful migration steps.
- Dashboard changes. The dashboard already polls the server; the new `/status` and `/config` endpoints are additive and don't break it.
- Changing the agent definition format or the dynamic-agent compilation semantics. The TS compiler must produce byte-identical output to the Python compiler for the same inputs.
- Changing the cpp lint rules. The mjs port must produce identical issue strings for the same fixtures.
