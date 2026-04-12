# Task Agent Type Override

## Goal

Add an `agent_type_override` column to the tasks table so that individual tasks can specify which agent type should execute them. When a container claims a task with an override, it fetches the required agent definition from the coordination server and runs Claude with that type — dynamically switching agent types between pump iterations.

## Context

Agent type is currently set per-container at launch via `AGENT_TYPE` (env var / config / CLI flag). Agent definitions are compiled on the host by `scripts/lib/compile-agents.sh` and volume-mounted into the container at `/staged-agents`. The container snapshots these into `/home/claude/.claude/agents/` at startup, then passes `--agent $AGENT_TYPE` to every `claude -p` invocation.

The task queue has no awareness of agent type — any agent can claim any task. The override column lets task authors express "this task requires agent type X." Instead of filtering at claim time, the container adapts: it downloads the needed agent definition from the server if it's not already present, then runs claude with the override type for that task.

The column is nullable. `NULL` means "use the container's default `AGENT_TYPE`." A non-null value means "run this task as that agent type."

The server already has the agent compiler (`server/src/agent-compiler.ts`). A new endpoint compiles and serves agent definitions on demand, so the container can fetch any type at claim time without a relaunch.

## Phase 1 — Schema: add agent_type_override to tasks

**Outcome:** The `tasks` table has an `agent_type_override` column (nullable text). The column exists in the Drizzle schema and a SQL migration.

**Types / APIs:**

```ts
// schema/tables.ts — tasks table, new column:
agentTypeOverride: text('agent_type_override'),
```

**Work:**

- Add `agentTypeOverride` to the `tasks` table definition in `server/src/schema/tables.ts`.
- Run `npm run db:generate` to produce the SQL migration in `server/drizzle/`.
- Run `npm run db:migrate` to verify the migration applies cleanly.

**Verification:** `npm run typecheck` passes. The generated migration file contains `ALTER TABLE tasks ADD COLUMN agent_type_override text`.

## Phase 2 — Task creation: accept and persist agent_type_override

**Outcome:** `POST /tasks`, `POST /tasks/batch`, and task ingestion accept and persist `agentTypeOverride`. The field appears in task API responses.

**Types / APIs:**

```ts
// TaskBody gains:
agentTypeOverride?: string;

// TaskRow gains:
agentTypeOverride: string | null;

// InsertOpts gains:
agentTypeOverride?: string;
```

**Work:**

- Add `agentTypeOverride` to `TaskBody`, `taskBodyKeys`, `PatchBody`, and `patchBodyKeys` in `server/src/routes/tasks-files.ts`.
- Add `agentTypeOverride` to `TaskRow` and `toTaskRow` in `server/src/routes/tasks-types.ts`.
- Add `agentTypeOverride` to `formatTask` output in `server/src/routes/tasks-types.ts`.
- Add `agentTypeOverride` to `InsertOpts` and the `insert` function in `server/src/queries/tasks-core.ts`.
- Thread `agentTypeOverride` through the `POST /tasks` handler in `server/src/routes/tasks.ts`.
- Thread `agentTypeOverride` through the `POST /tasks/batch` handler in `server/src/routes/tasks.ts`.
- Add `agentTypeOverride` to the frontmatter parsing in `server/src/task-ingest.ts` (read from `agent_type_override` or `agentTypeOverride` frontmatter key).
- Validate that `agentTypeOverride`, when provided, matches `AGENT_NAME_RE` (`^[a-zA-Z0-9_-]{1,64}$`).

**Verification:** `npm test` passes. Create a task with `agentTypeOverride: "container-reviewer"` — the response includes the field. Create without it — field is `null`. `PATCH /tasks/:id` can update the field. Ingest a markdown file with `agent_type_override: container-implementer` in frontmatter — stored correctly.

## Phase 3 — Server endpoint: compile and serve agent definitions

**Outcome:** `GET /agents/definitions/:type` compiles and returns a agent definition file (markdown + meta.json sidecar) on demand. The server uses the same `compileAgent` function from `server/src/agent-compiler.ts` that `launch.sh` uses at build time.

**Types / APIs:**

```ts
// GET /agents/definitions/:type
// Response:
{
  agentType: string;
  markdown: string;      // compiled agent .md content
  meta: { "access-scope": string };  // sidecar metadata
}
```

**Work:**

- Create `server/src/routes/agent-definitions.ts` as a Fastify plugin.
- The handler takes `:type` from the URL, validates it against `AGENT_NAME_RE`.
- Locate the source file: check `dynamic-agents/{type}.md` first, fall back to `agents/{type}.md`.
- If the source is a dynamic agent (has `skills` in frontmatter), call `compileAgent` from `server/src/agent-compiler.ts` to compile it to a temp directory, read the output, and return both the markdown and sidecar JSON.
- If the source is a static agent (no `skills`), read and return it directly with a default meta of `{ "access-scope": "read-only" }`.
- Return 404 if the type doesn't exist as either a dynamic or static agent.
- Register the plugin in `server/src/routes/index.ts`.

**Verification:** `npm test` passes. `GET /agents/definitions/container-implementer` returns the compiled markdown and meta. `GET /agents/definitions/nonexistent` returns 404.

## Phase 4 — Container: fetch and cache agent definitions at claim time

**Outcome:** When the pump loop claims a task with `agentTypeOverride`, the container fetches the agent definition from the server (if not already cached locally), writes it to the agents directory, and passes `--agent <override>` to claude instead of the default `AGENT_TYPE`.

**Types / APIs:**

```bash
# New function in container/lib/pump-loop.sh or a new container/lib/agent-fetch.sh:
# _ensure_agent_type <agent_type>
#   Checks if /home/claude/.claude/agents/<agent_type>.md exists.
#   If not, fetches from GET /agents/definitions/<agent_type> and writes:
#     /home/claude/.claude/agents/<agent_type>.md
#     /home/claude/.claude/agents/<agent_type>.meta.json
#   Returns 0 on success, 1 on failure.
```

**Work:**

- Create `container/lib/agent-fetch.sh` with `_ensure_agent_type` function.
- Source it from `container/entrypoint.sh` alongside the other libs.
- Update `_poll_and_claim_task` in `container/lib/pump-loop.sh` to read `agentTypeOverride` from the claimed task JSON: `CURRENT_TASK_AGENT_TYPE=$(echo "$body" | jq -r '.task.agentTypeOverride // ""')`.
- Update `_pump_iteration` in `container/lib/pump-loop.sh`: after claiming, if `CURRENT_TASK_AGENT_TYPE` is non-empty, call `_ensure_agent_type "$CURRENT_TASK_AGENT_TYPE"`. On failure, release the task and skip to next iteration.
- Update `_run_claude` in `container/lib/run-claude.sh`: use `CURRENT_TASK_AGENT_TYPE` (if set) instead of `AGENT_TYPE` for the `--agent` flag. The `AGENT_TYPE` env var remains the container's default — the override is per-task only.
- Reset `CURRENT_TASK_AGENT_TYPE=""` alongside the other task variables at the end of `_pump_iteration`.

**Verification:** Launch a pump container with `AGENT_TYPE=container-orchestrator`. Ingest a task with `agent_type_override: container-implementer`. The container claims the task, fetches `container-implementer.md` from the server, and runs claude with `--agent container-implementer`. The next task (no override) runs with the default `--agent container-orchestrator`. Verify the fetched definition is cached — a second task with the same override doesn't re-fetch.

## Phase 5 — GET /tasks filtering and dashboard

**Outcome:** `GET /tasks` supports an `agentTypeOverride` query filter. The dashboard tasks table displays the override column.

**Types / APIs:**

```ts
// GET /tasks?agentTypeOverride=container-reviewer
// Filters tasks to those with the specified override value.
// Use "__any__" to match non-null overrides, "__none__" to match null overrides.
```

**Work:**

- Add `agentTypeOverride` to `TaskListQueryInput` and `ParsedTaskListQuery` in `server/src/routes/tasks.ts`.
- Add the filter to `parseTaskListQuery` validation.
- Thread the filter into the list query in `server/src/queries/tasks-core.ts`.
- Add an `Agent Type` column to the dashboard tasks table in `dashboard/src/`.

**Verification:** `npm test` passes. `GET /tasks?agentTypeOverride=container-reviewer` returns only tasks with that override. The dashboard shows the column with appropriate styling (badge or text).
