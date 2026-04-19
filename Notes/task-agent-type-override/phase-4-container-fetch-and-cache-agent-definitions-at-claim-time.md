# Phase 4 — Container: fetch and cache agent definitions at claim time

Part of [Task Agent Type Override](./_index.md). See the index for the shared goal and context — this phase body assumes them.

**Outcome:** When the pump loop claims a task with `agentTypeOverride`, the container fetches the agent definition from
the server (if not already cached locally), writes it to the agents directory, and passes `--agent <override>` to claude
instead of the default `AGENT_TYPE`.

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
- Update `_poll_and_claim_task` in `container/lib/pump-loop.sh` to read `agentTypeOverride` from the claimed task JSON:
  `CURRENT_TASK_AGENT_TYPE=$(echo "$body" | jq -r '.task.agentTypeOverride // ""')`.
- Update `_pump_iteration` in `container/lib/pump-loop.sh`: after claiming, if `CURRENT_TASK_AGENT_TYPE` is non-empty,
  call `_ensure_agent_type "$CURRENT_TASK_AGENT_TYPE"`. On failure, release the task and skip to next iteration.
- Update `_run_claude` in `container/lib/run-claude.sh`: use `CURRENT_TASK_AGENT_TYPE` (if set) instead of `AGENT_TYPE`
  for the `--agent` flag. The `AGENT_TYPE` env var remains the container's default — the override is per-task only.
- Reset `CURRENT_TASK_AGENT_TYPE=""` alongside the other task variables at the end of `_pump_iteration`.

**Verification:** Launch a pump container with `AGENT_TYPE=container-orchestrator`. Ingest a task with
`agent_type_override: container-implementer`. The container claims the task, fetches `container-implementer.md` from the
server, and runs claude with `--agent container-implementer`. The next task (no override) runs with the default
`--agent container-orchestrator`. Verify the fetched definition is cached — a second task with the same override doesn't
re-fetch.
