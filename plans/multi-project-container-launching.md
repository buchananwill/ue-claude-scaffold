# Plan: Multi-Project Support for Container Launching

> User Feedback: after implementing the generalization of this scaffold, the scaffold needs to be able to serve the
> following projects: piste-perfect-ue-alpha (the current exclusive target), the Content Catalogue Dashboard sub-project
> within piste-perfect-ue-alpha, ue-claude-scaffold (i.e. itself: future development work on the scaffold will leverage
> its own container tooling), procedural-geometry-ideas (locally in directory "C:
> \Users\thele\Documents\GitHub\procedural-geometry"), and fep-dashboard-1.0.0. This is a diverse tech-stack, encompassing
> Unreal Engine, SQLite, Supabase, React with Vite and React with Next.js, and Mantine UI component library. This will
> require gradually growing new skills and agent teams, but the scope of this plan is the _container_ infrastructure and
> task queueing in which the agents will operate. Hence, the container launches will (amongst other changes) need to move
> toward a per-project launch model, e.g. using a flag to target a specific project amongst those supported. The container
> will thus only claim pending tasks belonging to _that_ project.

## Context

The scaffold has outgrown its single-project assumption. The coordination primitives (task queue, agent lifecycle,
message board, dependency graph, chat rooms) are already project-agnostic. The coupling is in the config/launch layer:
one `scaffold.config.json` with one `project` object, one `server.bareRepoPath`, one set of volume mounts. This plan
adds a `projects` map to config and a `--project` flag to `launch.sh`, so each container launch can target a different
project — all sharing one coordination server.

**Key insight:** Most projects have their own bare repo, so branch naming (`docker/{agent-name}`,
`docker/current-root`) doesn't change. Project isolation comes from bare-repo isolation, not branch namespacing.

**Sub-project model:** The Content Catalogue Dashboard lives inside the piste-perfect-ue-alpha repo and shares its bare
repo. It gets its own `project_id` so that (a) its tasks are scoped independently, (b) its agents declare a non-UE tech
stack (React/Vite/Mantine), (c) it gets its own agent branches (`docker/{agent-name}`) within the shared bare repo, and
(d) it does not contend for the UBT lock. Two projects sharing one bare repo is fine — agent branches are already
namespaced by agent name, and `docker/current-root` is shared intentionally.

**Out of scope:** Build strategy generalisation (issue 021), dashboard project selector (future), container instruction
layering (issue 018 §4).

**Now in scope (Phase 3a):** Agent definition overlays (issue 018 §3) — resolved via the dynamic agent compiler, which
composes agents from modular skills at launch time.

---

## Phase 1: Config Restructuring

**Goal:** Server and scripts can parse both legacy single-project config and new multi-project config, exposing a
unified `projects` map internally. No behavioural change yet.

### Files

**`server/src/config.ts`**

- Extract a `ProjectConfig` interface from the existing fields:
  ```ts
  export interface ProjectConfig {
    name: string;
    path: string;
    uprojectFile?: string;       // UE only
    bareRepoPath: string;
    tasksPath?: string;
    planBranch?: string;          // default: 'docker/current-root'
    engine?: { path: string; version: string };
    build?: { /* existing build fields */ };
    plugins?: { stagingCopies?: Array<{ source: string; relativeDest: string }> };
    stagingWorktreeRoot?: string;
  }
  ```
- Add `projects?: Record<string, ProjectConfig>` to `ScaffoldConfig`
- In `loadConfig()`: if `raw.projects` exists, parse it into a `resolvedProjects` map. Otherwise, synthesise
  `{ default: { ...legacy fields } }`.
- Add `getProject(id: string): ProjectConfig` helper that throws on unknown ID.
- **Keep the legacy top-level fields on `ScaffoldConfig`** — they become the `default` project's values. Existing code
  that reads `config.project.path` still works.
- Relax validation: `engine.path` and `build.scriptPath`/`testScriptPath` are only required when the project declares
  them (or for legacy configs where they're present).

**`scaffold.config.example.json`**

- Add a `"projects"` block showing multi-project structure alongside the existing single-project fields. Concrete
  example for the five target projects:

  ```jsonc
  "projects": {
    "my-ue-game": {
      "name": "MyUEGame",
      "path": "/home/dev/projects/my-ue-game",
      "uprojectFile": "MyUEGame.uproject",
      "bareRepoPath": "/srv/bare-repos/my-ue-game.git",
      "stagingWorktreeRoot": "/srv/staging/my-ue-game",
      "engine": { "path": "/opt/UnrealEngine/5.5", "version": "5.5" },
      "build": {
        "scriptPath": "Scripts/build.py",
        "testScriptPath": "Scripts/run_tests.py",
        "buildTimeoutMs": 660000,
        "testTimeoutMs": 700000
      }
    },
    "my-ue-game-dashboard": {
      // Sub-project: shares the parent's bare repo and source path.
      // Gets its own project_id for independent task scoping and no UBT lock.
      "name": "MyUEGameDashboard",
      "path": "/home/dev/projects/my-ue-game",
      "bareRepoPath": "/srv/bare-repos/my-ue-game.git",
      "tasksPath": "Dashboard/tasks"
    },
    "this-scaffold": {
      // Self-hosting: the scaffold targets itself for development.
      "name": "UEClaudeScaffold",
      "path": "/home/dev/projects/my-ue-game/ue-claude-scaffold",
      "bareRepoPath": "/srv/bare-repos/ue-claude-scaffold.git",
      "stagingWorktreeRoot": "/srv/staging/ue-claude-scaffold"
    },
    "side-project": {
      "name": "SideProject",
      "path": "/home/dev/projects/side-project",
      "bareRepoPath": "/srv/bare-repos/side-project.git",
      "stagingWorktreeRoot": "/srv/staging/side-project"
    },
    "web-dashboard": {
      "name": "WebDashboard",
      "path": "/home/dev/projects/web-dashboard",
      "bareRepoPath": "/srv/bare-repos/web-dashboard.git",
      "stagingWorktreeRoot": "/srv/staging/web-dashboard"
    }
  }
  ```

  Key patterns demonstrated:
  - **UE project** (`my-ue-game`): full `engine` + `build` config, gets UBT lock contention.
  - **Sub-project** (`my-ue-game-dashboard`): shares `path` and `bareRepoPath` with parent; no `engine`/`build`, so no
    UBT lock. Own `project_id` scopes its tasks and agents independently.
  - **Self-hosting** (`this-scaffold`): the scaffold targets itself for container-based development.
  - **Non-UE projects** (`side-project`, `web-dashboard`): no `engine`/`build` fields.

### Backwards compat

Legacy config (no `projects` key) produces `resolvedProjects = { default: { ...existing } }`. All existing code paths
unchanged.

### Verification

- `npm test` passes with no config changes.
- Unit test: `loadConfig()` with legacy config produces correct `resolvedProjects`.
- Unit test: `loadConfig()` with multi-project config produces correct map.

---

## Phase 2: DB Schema — Add `project_id` Column

**Goal:** Project-scoped tables get `project_id TEXT NOT NULL DEFAULT 'default'`. Existing rows migrate transparently.

### File: `server/src/db.ts`

v12 → v13 migration. Add `project_id` to:

- `agents` — agents belong to a project
- `tasks` — tasks are scoped to a project
- `files` — file ownership is per-project (same path can exist in different projects)
- `build_history` — build logs are per-project
- `ubt_lock` — each project gets its own UBT lock
- `ubt_queue` — lock queue is per-project

Tables left unchanged (already project-agnostic by design):

- `rooms`, `room_members`, `chat_messages` — chat rooms span projects
- `teams`, `team_members` — teams can span projects
- `messages` — message board is cross-cutting
- `task_dependencies`, `task_files` — keyed by task_id which is already project-scoped

**Migration robustness note:** The current v11→v12 migration uses a try/catch `ALTER TABLE` pattern as a safety net
against version-stamp/schema skew (e.g., test DBs stamped as v12 but lacking the column). For v12→v13, tables that use
create-copy-drop-rename (`files`, `ubt_lock`) are inherently safe. But simple `ALTER TABLE ADD COLUMN` changes
(`agents`, `tasks`, `build_history`, `ubt_queue`) must use the same defensive try/catch pattern, or a DB that was
stamped v13 during fresh `CREATE TABLE` but later reused against an older table will silently lack `project_id`.

**UBT lock migration:** The current singleton constraint (`id = 1`) prevents multiple project locks. Migration:

1. Create `ubt_lock_v2 (project_id TEXT PRIMARY KEY, holder TEXT, acquired_at DATETIME, priority INTEGER DEFAULT 0)`
2. Copy existing row with `project_id = 'default'`
3. Drop `ubt_lock`, rename `ubt_lock_v2`
4. Add `project_id` column to `ubt_queue` with DEFAULT 'default'

**Files table:** Change PRIMARY KEY from `(path)` to composite. Since SQLite can't ALTER PRIMARY KEY, use the
create-copy-drop-rename pattern:
`files_v2 (project_id TEXT NOT NULL DEFAULT 'default', path TEXT, claimant TEXT, claimed_at DATETIME, PRIMARY KEY (project_id, path))`.

**Fresh schema (SCHEMA_SQL):** Update all CREATE TABLE statements to include `project_id`. Update schema_version to 13.

### Backwards compat

DEFAULT 'default' on all new columns means existing data migrates in place. No query changes yet — filtering comes in
Phase 4.

### Verification

- Migration test: open a v12 DB, call `openDb()`, verify columns exist, verify existing rows have
  `project_id = 'default'`.
- Full `npm test` passes (no queries filter on `project_id` yet).

---

## Phase 3: `launch.sh` — Add `--project` Flag

**Goal:** `launch.sh --project <id>` resolves per-project config and exports it for the container.

### File: `launch.sh`

1. Add `--project` to CLI parsing. Store in `_CLI_PROJECT`. Default: `"default"`.

2. After loading `scaffold.config.json`, resolve project config:
   ```bash
   if jq -e ".projects[\"$PROJECT_ID\"]" "$_cfg" >/dev/null 2>&1; then
     # Multi-project mode: read from projects map
     BARE_REPO_PATH=$(jq -r ".projects[\"$PROJECT_ID\"].bareRepoPath // empty" "$_cfg")
     PROJECT_PATH=$(jq -r ".projects[\"$PROJECT_ID\"].path // empty" "$_cfg")
     # ... etc
   else
     # Legacy mode: read from top-level fields (existing code)
   fi
   ```

3. Export `PROJECT_ID` as env var for docker-compose.

4. Validation: if `--project` is specified and the ID isn't found in `projects`, error out with available project IDs
   listed.

5. Dry-run output: add `PROJECT_ID` line.

6. Worker/pump mode: `--project` applies equally to `--worker` and `--pump` launches. The exported `PROJECT_ID` env var
   flows into the container, which sends `X-Project-Id` on `claim-next` calls. This is how a worker container only
   claims tasks belonging to its project. No separate flag needed — `--project` + `--worker` compose naturally.

7. Team mode: `launch_team_member` passes `PROJECT_ID` to each member.

7. Usage text: add `--project ID` to help.

### File: `container/docker-compose.example.yml`

Add `PROJECT_ID=${PROJECT_ID:-default}` to the environment block.

### Backwards compat

No `--project` flag = `PROJECT_ID=default` = legacy config resolution = identical behaviour.

### Verification

- `./launch.sh --dry-run` output unchanged.
- `./launch.sh --project myproject --dry-run` shows per-project values.
- `./launch.sh --project nonexistent --dry-run` errors with helpful message.

---

## Phase 4: Thread `project_id` Through Server Routes

**Goal:** Routes read `X-Project-Id` header (default `"default"`) and filter/insert accordingly.

### Approach

Add a Fastify `onRequest` hook that extracts `X-Project-Id` from headers, validates it against the `resolvedProjects`
map, and decorates the request with the resolved `ProjectConfig`. Routes access it via `request.projectId` and
`request.projectConfig`.

### Files to modify

**`server/src/routes/agents.ts`**

- `POST /agents/register`: store `project_id` from header.
- `GET /agents`: add optional `?project` query filter. Without it, return all (dashboard compat).
- `POST /agents/:name/sync`: resolve `bareRepoPath` and `planBranch` from the agent's stored `project_id`.

**`server/src/routes/build.ts`**

- `POST /build`, `POST /test`: look up requesting agent's `project_id` from agents table. Use that project's config for
  `bareRepoPath`, `stagingWorktreeRoot`, build scripts, timeouts.
- `getStagingWorktree()` and `getBareRepoPath()` become project-aware.

**`server/src/routes/ubt.ts`**

- `POST /ubt/acquire`, `POST /ubt/release`, `GET /ubt/status`: filter by `project_id` from header.
- `sweepStaleLock()`: iterate all project locks.

**`server/src/routes/sync.ts`**

- `POST /sync/plans`: resolve `bareRepoPath` and `project.path` from `X-Project-Id`.

**`server/src/routes/tasks.ts`** (and tasks-claim, tasks-lifecycle, tasks-files)

- `POST /tasks`, `POST /tasks/batch`: store `project_id`.
- `GET /tasks`: filter by `project_id` from header/query.
- `POST /tasks/claim-next`: agent can only claim tasks from its own project.

**`server/src/routes/files.ts`**

- Scope file queries by `project_id`.

**`server/src/routes/builds.ts`**

- Add optional `?project` query filter.

**`server/src/routes/coalesce.ts`**

- Scope pause/release to `project_id`.

### Backwards compat

Every header defaults to `"default"`. Every SQL query's new `WHERE project_id = ?` matches existing rows (all have
`'default'`). Existing containers that don't send the header get correct behaviour.

### Verification

- Full `npm test` passes (tests use default project).
- New tests: register agent with `project_id = 'proj-b'`, create tasks, verify isolation (proj-a agent can't claim
  proj-b tasks, separate UBT locks, etc.).

---

## Phase 5: Container Updates — Pass `PROJECT_ID` Header

**Goal:** Container sends `X-Project-Id` in all HTTP calls to the server.

### Files

**`container/entrypoint.sh`**

- Read `PROJECT_ID` env var (default `"default"`).
- Add `-H "X-Project-Id: ${PROJECT_ID}"` to every `curl` call: registration, status updates, task
  claim/complete/fail/release, abnormal shutdown messages, agent status polling.
- Helper function to reduce duplication:
  ```bash
  _curl_server() {
    curl "$@" -H "X-Agent-Name: ${AGENT_NAME}" -H "X-Project-Id: ${PROJECT_ID}"
  }
  ```

**`container/hooks/intercept_build_test.sh`**

- Add `X-Project-Id` header to all `curl` calls (UBT acquire/release, build/test, messages).

**`container/hooks/inject-agent-header.sh`**

- Add `X-Project-Id` header alongside `X-Agent-Name`.

### Backwards compat

`PROJECT_ID` defaults to `"default"`. All existing containers continue to work.

### Verification

- Launch a container with default project, verify all HTTP calls include `X-Project-Id: default` (check server logs).
- Launch with `--project foo`, verify `X-Project-Id: foo`.

---

## Phase 6: `setup.sh` — Per-Project Bare Repo Init

**Goal:** `setup.sh` creates bare repos for all configured projects.

### File: `setup.sh`

After loading config, check for `projects` key:

- If present: iterate each project, create bare repo if `bareRepoPath` and `path` are both set and bare repo doesn't
  exist.
- If absent: existing single-project logic (unchanged).

Each project's bare repo gets its own `docker/current-root` branch.

### Backwards compat

No `projects` key = existing behaviour.

### Verification

- Run `setup.sh --non-interactive` with multi-project config. Verify each bare repo exists with `docker/current-root`.

---

## Phase 7: `stop.sh` and `status.sh` — Project-Aware Operations

**Goal:** Stop and status commands can target a specific project.

### File: `stop.sh`

1. Add `--project ID` flag to CLI parsing. Store in `PROJECT_ID` (default: all projects).

2. `stop_all()`: when `--project` is set, filter running containers to those whose agent is registered under that
   project (query `GET /agents?project=$PROJECT_ID` to get the name list). Without `--project`, behaviour is unchanged
   (stop all `claude-*` containers).

3. `--drain` mode: when `--project` is set, `POST /coalesce/pause` and `GET /coalesce/status` should send
   `X-Project-Id` header so only that project's pumps are paused and only its in-flight tasks are awaited.

4. Usage text: add `--project ID` to help and examples.

### File: `status.sh`

1. Add `--project ID` flag to CLI parsing.

2. Agent table: when `--project` is set, `GET /agents?project=$PROJECT_ID`. Without it, show all agents but add a
   `PROJECT` column to the table output.

3. Tasks section: when `--project` is set, `GET /tasks?project=$PROJECT_ID&limit=20`. Without it, show all tasks but
   add a `PROJECT` column.

4. Usage text: add `--project ID` to help and examples.

### Backwards compat

No `--project` flag = existing behaviour (all projects shown/stopped).

### Verification

- `./stop.sh --project my-ue-game --agent agent-1` stops only that agent.
- `./stop.sh --drain --project my-ue-game` pauses only that project's pumps.
- `./status.sh` shows all agents with project column.
- `./status.sh --project my-ue-game` filters to that project's agents and tasks.

---

## Phase 3a: Dynamic Agent Compilation

**Goal:** Container launches receive compiled, self-contained agent files assembled from modular skill definitions.
Agents and skills follow a DRY single-source model — each skill is authored once in `skills/`, each dynamic agent is a
thin identity paragraph plus a `skills` list in frontmatter. A compiler splices skill content into a standard Claude Code
agent file at launch time.

### Background

Agent definitions for container teams contain significant duplicated content: build routing instructions, action boundary
discipline, output schemas, debrief protocols, and message board usage are copy-pasted across every agent. The dynamic
agent system eliminates this by factoring shared knowledge into orthogonal skills (already extracted into `skills/`) and
composing agents from them at compile time.

### Directory Layout

```
dynamic-agents/              ← source definitions (committed, git-tracked)
  container-orchestrator.md
  container-implementer.md
  container-reviewer.md
  ...
skills/                      ← skill library (committed, already exists)
  action-boundary/SKILL.md
  container-build-routing/SKILL.md
  ...
.compiled-agents/            ← compiler output (gitignored, ephemeral)
```

### Dynamic Agent Format

A dynamic agent file uses standard Claude Code agent frontmatter plus a `skills` field:

```markdown
---
name: container-implementer
description: "..."
model: inherit
color: green
tools: [Read, Edit, Write, Glob, Grep, Bash]
skills:
  - action-boundary
  - container-build-routing
  - implementation-loop
  - ue-correctness
---

Single paragraph explaining this agent's identity and purpose.
```

The `skills` field is consumed by the compiler and removed from output. The compiled file is a standard Claude Code
agent — valid frontmatter, no `skills` field, skill content spliced into the system prompt body.

### Compiler: `scripts/compile-agent.py`

**Already implemented.** Takes a dynamic agent file (or `--all`), resolves each skill by reading
`skills/{name}/SKILL.md`, strips skill frontmatter, and appends skill body content after the agent's identity paragraph.
Output goes to `.compiled-agents/` (or a custom `-o` path).

**Phase 3a adds:** One-level sub-agent recursion. When compiling a lead agent (e.g. `container-orchestrator`), the
compiler must also compile the sub-agents that the lead's skills reference. This keeps the container's agent discovery
path lean — it contains only the lead agent and the sub-agents it actually delegates to.

### Sub-Agent Resolution (One-Level Recursion)

Sub-agent names are declared inside **skills**, not in the dynamic agent definition. For example,
`orchestrator-system-wiring` contains an agent resolution table listing `container-implementer`,
`container-style-reviewer`, etc. This is correct — the mapping from roles to agents is a Protocol concern that belongs
in the skill, not the agent.

The compiler resolves sub-agents as follows:

1. **Compile the lead dynamic agent** — resolve its `skills` list, splice skill content into the body.
2. **Scan the spliced skill content** for references to other dynamic agents. Match against filenames in
   `dynamic-agents/` (e.g. if skill text mentions `container-implementer` and
   `dynamic-agents/container-implementer.md` exists, it's a match).
3. **Compile each matched sub-agent** — resolve *their* skills, splice content. No further recursion.
4. **If a sub-agent's skills reference other agents**, that's a configuration error (sub-agents can't launch
   sub-agents). The compiler logs a warning but does not recurse further.

This ensures:
- The lead agent's container sees exactly the agents it needs — no noise.
- Sub-agent references live in skills (single source of truth), not duplicated in agent definitions.
- The system is deterministic: same inputs → same compiled output.

### Wiring into `launch.sh`

After config resolution and before `docker compose up`, `launch.sh` calls the compiler:

```bash
# ── Compile dynamic agents ─────────────────────────────────────────────────
COMPILED_AGENTS_DIR="$(mktemp -d)"
trap 'rm -rf "$COMPILED_AGENTS_DIR"' EXIT

if [ -d "$SCRIPT_DIR/dynamic-agents" ] && [ -f "$SCRIPT_DIR/dynamic-agents/${AGENT_TYPE}.md" ]; then
  echo "Compiling dynamic agent: ${AGENT_TYPE}..."
  python "$SCRIPT_DIR/scripts/compile-agent.py" \
    "$SCRIPT_DIR/dynamic-agents/${AGENT_TYPE}.md" \
    -o "$COMPILED_AGENTS_DIR" \
    --recursive
else
  # Fallback: copy static agents directory (legacy behaviour)
  cp "$SCRIPT_DIR/agents/"*.md "$COMPILED_AGENTS_DIR/" 2>/dev/null || true
fi

export AGENTS_PATH="$COMPILED_AGENTS_DIR"
```

Key points:
- Compiled output goes to a temp directory, not a persistent path — truly ephemeral.
- `--recursive` flag triggers the one-level sub-agent scan and compilation.
- If the requested `AGENT_TYPE` doesn't have a dynamic agent definition, falls back to copying static agents.
- The temp directory is cleaned up on script exit.

### Compiler `--recursive` Flag

Add to `scripts/compile-agent.py`:

1. After compiling the lead agent, read back the compiled output.
2. Collect all `dynamic-agents/*.md` filenames (sans extension) as the candidate set.
3. Scan the compiled body for occurrences of any candidate name.
4. For each match, compile that dynamic agent into the same output directory.
5. Log which sub-agents were resolved.
6. Do NOT recurse into sub-agents' compiled output.

### `docker-compose.example.yml` Change

The `AGENTS_PATH` default changes from `../agents` to a path provided by `launch.sh`:

```yaml
- ${AGENTS_PATH}:/home/claude/.claude/agents:ro
```

No default fallback needed — `launch.sh` always sets `AGENTS_PATH` (either compiled or static copy).

### Dry-Run Output

`launch.sh --dry-run` shows the compilation step:

```
  AGENT_TYPE:       container-orchestrator
  AGENT_COMPILED:   yes (dynamic-agents/container-orchestrator.md)
  SUB_AGENTS:       container-implementer, container-style-reviewer, container-safety-reviewer,
                    container-reviewer, container-tester, container-decomposition-reviewer
```

### Backwards Compat

- No `dynamic-agents/` directory or no matching file → static `agents/` directory is copied as-is.
- Existing containers that mount `agents/` directly continue to work until migrated.
- The compiler has zero external dependencies (no PyYAML).

### Verification

- `python scripts/compile-agent.py dynamic-agents/container-orchestrator.md --recursive` compiles lead + all sub-agents.
- Compiled files are valid Claude Code agents (frontmatter present, no `skills` field, body includes skill content).
- `launch.sh --dry-run` shows compilation summary.
- Container launched with compiled agents can resolve `--agent container-orchestrator` and delegate to sub-agents.
- `launch.sh --dry-run` without `dynamic-agents/` directory works identically to current behaviour.

---

## Phase Ordering

```
Phase 1 (config)   ─┐
Phase 2 (schema)   ─┼─ independent, can be done in parallel
Phase 3a (compile) ─┤
Phase 6 (setup)    ─┘
         │
Phase 3 (launch.sh) ── depends on Phase 1 + 3a
         │
Phase 4 (server routes) ── depends on Phase 1 + 2
         │
Phase 5 (container) ── depends on Phase 3 + 4
Phase 7 (stop/status) ── depends on Phase 4
```

Recommended merge order: **1 → 2 → 3a → 6 → 3 → 4 → 5 → 7**

Phases 1, 2, 3a, and 6 are purely additive and can ship independently with zero behavioural change. Phase 3a (compiler)
can be validated standalone before wiring into launch.sh. Phase 3 needs Phase 1 + 3a. Phase 4 needs 1+2. Phase 5 needs
3+4. Phase 7 needs 4 (server routes with `?project` query support).

---

## Critical Files

| File                                      | Phase |
|-------------------------------------------|-------|
| `server/src/config.ts`                    | 1, 4  |
| `server/src/db.ts`                        | 2     |
| `scaffold.config.example.json`            | 1     |
| `scripts/compile-agent.py`                | 3a    |
| `dynamic-agents/*.md`                     | 3a    |
| `launch.sh`                               | 3, 3a |
| `setup.sh`                                | 6     |
| `container/entrypoint.sh`                 | 5     |
| `container/docker-compose.example.yml`    | 3     |
| `container/hooks/intercept_build_test.sh` | 5     |
| `container/hooks/inject-agent-header.sh`  | 5     |
| `server/src/routes/agents.ts`             | 4     |
| `server/src/routes/build.ts`              | 4     |
| `server/src/routes/ubt.ts`                | 4     |
| `server/src/routes/sync.ts`               | 4     |
| `server/src/routes/tasks.ts`              | 4     |
| `server/src/routes/tasks-claim.ts`        | 4     |
| `server/src/routes/tasks-lifecycle.ts`    | 4     |
| `server/src/routes/tasks-files.ts`        | 4     |
| `server/src/routes/files.ts`              | 4     |
| `server/src/routes/builds.ts`             | 4     |
| `server/src/routes/coalesce.ts`           | 4, 7  |
| `stop.sh`                                 | 7     |
| `status.sh`                               | 7     |

## End-to-End Verification

1. With NO config changes: `npm test` passes, `launch.sh --dry-run` unchanged, server starts.
2. With legacy config: `launch.sh --project default --dry-run` works identically to `launch.sh --dry-run`.
3. With multi-project config: `launch.sh --project proj-b --dry-run` shows proj-b's paths.
4. Server isolation: agent registered on proj-a cannot claim proj-b tasks; separate UBT locks per project.
5. Full round-trip: launch two containers targeting different projects, verify they use separate bare repos, separate
   task queues, separate file ownership.
6. Dynamic agent compilation: `launch.sh --dry-run` with a dynamic agent type shows compilation summary, lists resolved
   sub-agents. Compiled output contains only the lead agent and its skill-referenced sub-agents — nothing else.
7. Fallback: `launch.sh --dry-run` with an agent type that has no dynamic definition falls back to static agents.
