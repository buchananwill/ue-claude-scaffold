# Task Agent Type Override

## Goal

Add an `agent_type_override` column to the tasks table so that individual tasks can specify which agent type should
execute them. When a container claims a task with an override, it fetches the required agent definition from the
coordination server and runs Claude with that type — dynamically switching agent types between pump iterations.

## Context

Agent type is currently set per-container at launch via `AGENT_TYPE` (env var / config / CLI flag). Agent definitions
are compiled on the host by `scripts/lib/compile-agents.sh` and volume-mounted into the container at `/staged-agents`.
The container snapshots these into `/home/claude/.claude/agents/` at startup, then passes `--agent $AGENT_TYPE` to every
`claude -p` invocation.

The task queue has no awareness of agent type — any agent can claim any task. The override column lets task authors
express "this task requires agent type X." The container adapts itself to match the type required for the task: it downloads the
needed agent definition from the server if it's not already present, then runs claude with the override type for that
task.

The column is nullable. `NULL` means "use the container's default `AGENT_TYPE`." A non-null value means "run this task
as that agent type."

The server already has the agent compiler (`server/src/agent-compiler.ts`). A new endpoint compiles and serves agent
definitions on demand, so the container can fetch any type at claim time without a relaunch.

## Phases

1. [Phase 1 — Schema: add agent_type_override to tasks](./phase-1-schema-add-agent-type-override-to-tasks.md)
2. [Phase 2 — Task creation: accept and persist agent_type_override](./phase-2-task-creation-accept-and-persist-agent-type-override.md)
3. [Phase 3 — Server endpoint: compile and serve agent definitions](./phase-3-server-endpoint-compile-and-serve-agent-definitions.md)
4. [Phase 4 — Container: fetch and cache agent definitions at claim time](./phase-4-container-fetch-and-cache-agent-definitions-at-claim-time.md)
5. [Phase 5 — GET /tasks filtering and dashboard](./phase-5-get-tasks-filtering-and-dashboard.md)
