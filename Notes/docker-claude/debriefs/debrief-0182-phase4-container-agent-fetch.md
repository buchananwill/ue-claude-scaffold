# Debrief 0182 -- Phase 4: Container fetch and cache agent definitions at claim time

## Task Summary

Implement Phase 4 of the task-agent-type-override plan. When the pump loop claims a task that has an `agentTypeOverride` field, the container fetches that agent definition from the coordination server's `GET /agents/definitions/:type` endpoint, caches it locally, and passes the override type to Claude via `--agent` instead of the container's default `AGENT_TYPE`.

## Changes Made

- **container/lib/agent-fetch.sh** (CREATED): New library file containing the `_ensure_agent_type` function. Checks if the agent definition `.md` file already exists in `$AGENTS_DIR`; if not, fetches it from the server, extracts the compiled markdown and access-scope metadata, and writes both `<type>.md` and `<type>.meta.json` files. Returns 0 on success, 1 on failure.

- **container/entrypoint.sh** (MODIFIED): Added `source` line for `container/lib/agent-fetch.sh`, placed between `post-setup.sh` and `pump-loop.sh` sourcing, with a `shellcheck source=` directive.

- **container/lib/pump-loop.sh** (MODIFIED): Three changes:
  1. In `_poll_and_claim_task`: added extraction of `CURRENT_TASK_AGENT_TYPE` from the claimed task JSON via `jq -r '.task.agentTypeOverride // ""'`.
  2. In `_pump_iteration`: after claiming a task, if `CURRENT_TASK_AGENT_TYPE` is non-empty, calls `_ensure_agent_type`. On failure, releases the task and returns (skips to next iteration).
  3. In the task-variable reset block at the end of `_pump_iteration`: added `CURRENT_TASK_AGENT_TYPE=""`.

- **container/lib/run-claude.sh** (MODIFIED): In `_run_claude`, computes `effective_agent_type` as `CURRENT_TASK_AGENT_TYPE` if set, otherwise `AGENT_TYPE`. Uses this for the `--agent` flag and the startup log line.

- **container/lib/env.sh** (MODIFIED): Added `CURRENT_TASK_AGENT_TYPE=""` initialization alongside the other `CURRENT_TASK_*` variables.

## Design Decisions

- The `_ensure_agent_type` function writes both `.md` and `.meta.json` files to match the convention established by `_snapshot_agents` in workspace-setup.sh. The meta.json contains `access-scope` extracted from the server response's `metadata` field.

- Cache-first approach: if the `.md` file already exists, no HTTP request is made. This means a second task with the same override type reuses the cached definition without re-fetching.

- On fetch failure, the task is released back to pending (not failed), matching the existing pattern for recoverable errors. The pump continues to the next iteration.

- The `effective_agent_type` local variable is declared early in `_run_claude` (before the log line) so the startup message accurately reports which agent type will be used.

## Build & Test Results

- Shell syntax checks (`bash -n`): all five modified/created scripts pass.
- Server build (`npm run build`): clean, no errors.

## Open Questions / Risks

- The `GET /agents/definitions/:type` response shape must include a `compiled` field (string) and optionally `metadata["access-scope"]`. This was implemented in Phase 3; if the response shape differs, `_ensure_agent_type` will fail gracefully (returns 1, releases the task).

- The cache is not invalidated during a container's lifetime. If an agent definition is updated on the server, a running container will continue using the cached version until the container restarts. This is acceptable for the current design where containers are short-lived.

## Suggested Follow-ups

- Consider adding a `--no-cache` or TTL-based cache invalidation for long-running pump containers.
- The single-task mode path in `entrypoint.sh` does not yet handle `agentTypeOverride`. If single-task mode needs this feature, the override logic would need to be added after `_poll_and_claim_task` and before `_run_claude` in that code path.
