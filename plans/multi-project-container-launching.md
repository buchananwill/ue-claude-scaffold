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

**Key insight:** Each project has its own bare repo, so branch naming (`docker/{agent-name}`, `docker/current-root`)
doesn't change. Project isolation comes from bare-repo isolation, not branch namespacing.

**Out of scope:** Build strategy generalisation (issue 021), agent definition overlays (issue 018 §3, separate agent
working on this), dashboard project selector (future), container instruction layering (issue 018 §4).

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

- Add a commented `"projects"` block showing multi-project structure alongside the existing single-project fields.

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

6. Team mode: `launch_team_member` passes `PROJECT_ID` to each member.

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

## Phase Ordering

```
Phase 1 (config)  ─┐
Phase 2 (schema)  ─┼─ independent, can be done in parallel
Phase 6 (setup)   ─┘
         │
Phase 3 (launch.sh) ── depends on Phase 1
         │
Phase 4 (server routes) ── depends on Phase 1 + 2
         │
Phase 5 (container) ── depends on Phase 3 + 4
```

Recommended merge order: **1 → 2 → 6 → 3 → 4 → 5**

Phases 1, 2, and 6 are purely additive and can ship independently with zero behavioural change. Phase 3 needs Phase 1.
Phase 4 needs 1+2. Phase 5 needs 3+4.

---

## Critical Files

| File                                      | Phase |
|-------------------------------------------|-------|
| `server/src/config.ts`                    | 1, 4  |
| `server/src/db.ts`                        | 2     |
| `scaffold.config.example.json`            | 1     |
| `launch.sh`                               | 3     |
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
| `server/src/routes/coalesce.ts`           | 4     |

## End-to-End Verification

1. With NO config changes: `npm test` passes, `launch.sh --dry-run` unchanged, server starts.
2. With legacy config: `launch.sh --project default --dry-run` works identically to `launch.sh --dry-run`.
3. With multi-project config: `launch.sh --project proj-b --dry-run` shows proj-b's paths.
4. Server isolation: agent registered on proj-a cannot claim proj-b tasks; separate UBT locks per project.
5. Full round-trip: launch two containers targeting different projects, verify they use separate bare repos, separate
   task queues, separate file ownership.
