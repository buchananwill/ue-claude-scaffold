# Debrief 0096 — Phase 14: Fix and decompose stop.sh

## Task Summary

Implement Phase 14 (Steps 75-78) of the shell script decomposition plan:
- Step 75: Fix `local` outside-function bug in stop.sh
- Step 76: Fix inconsistent compose-project naming in team-mode block
- Step 77: Extract `_signal_and_stop_projects` into `scripts/lib/stop-helpers.sh`
- Step 78: Replace drain-mode polling loop with a call to `POST /coalesce/drain`

## Changes Made

- **scripts/lib/stop-helpers.sh** (created): New library with `_signal_stop` and `_signal_and_stop_projects` functions. The latter signals all agents via the coordination server, then runs `docker compose down` for each project. Used from all four modes in stop.sh.

- **stop.sh** (rewritten): Refactored to source shared libraries (`compose-detect.sh`, `validators.sh`, `stop-helpers.sh`). All four modes (default, agent, team, drain) now use `_signal_and_stop_projects`. Validation uses `_validate_identifier` from the library. Compose detection uses `_detect_compose`.

- **server/src/routes/coalesce.ts** (modified): Added `POST /coalesce/drain` endpoint. Accepts `{timeout, projectId}` in the request body. Implements the full drain state machine: pause pump agents, poll until canCoalesce or timeout, return final status including `drained`, `timedOut`, `paused`, `inFlightAtStart`, `activeTasks`, `pendingTasks`, `totalClaimedFiles`.

- **server/src/routes/coalesce.test.ts** (modified): Added 5 tests for the drain endpoint covering: success with no active tasks, in-flight task reporting, timeout behavior, projectId in body, and empty body defaults.

- **server/src/routes/teams.ts** (modified): Added `projectId` field to the `GET /teams/:id` response so stop.sh team mode can build correct compose project names.

## Design Decisions

1. **Step 75 was already fixed**: The current stop.sh had no `local` at global scope -- Phase 13 already resolved this. No change needed.

2. **Team mode compose naming (Step 76)**: The team GET response now returns `projectId` from the teams table. stop.sh extracts it and uses `claude-${team_project_id}-${member}` format, matching launch.sh's `_compose_project_name` convention. Falls back to `--project` flag or `default`.

3. **Agent name extraction in _signal_and_stop_projects**: Strips `claude-` prefix, then strips everything up to and including the first `-` to get the agent name from the compose project name format `claude-${PROJECT_ID}-${AGENT_NAME}`. This works because project IDs are identifiers without hyphens in the first segment.

4. **Drain endpoint polling interval**: Set to 2 seconds server-side (vs 5 seconds in the old shell polling loop) since the overhead is lower when the server polls its own DB.

5. **Drain timeout clamping**: Server clamps timeout to [1, 3600] seconds to prevent abuse. Shell-side curl timeout is set to `TIMEOUT + 30` to account for the server's final status query.

## Build & Test Results

- `npm run build` in server/: SUCCESS (clean compile)
- `bash -n stop.sh`: SUCCESS
- `bash -n scripts/lib/stop-helpers.sh`: SUCCESS
- Coalesce tests: 19/19 PASS
- Teams tests: 23/23 PASS
- Full server suite: 474 pass, 58 fail (all failures pre-existing in unrelated areas: agent sync with git, task dependency features)

## Open Questions / Risks

- The `_signal_and_stop_projects` agent name extraction assumes project IDs don't contain hyphens that would confuse the parsing. If a project ID is `my-project` and agent is `agent-1`, the compose name is `claude-my-project-agent-1`, and extracting the agent name by stripping up to the first `-` after `claude-` would yield `project-agent-1`. This is an inherent limitation of the hyphen-separated naming convention. A more robust approach would store the mapping, but this matches the existing convention.

- The drain endpoint uses `setTimeout` for polling in an async context. For very long timeouts, this holds a Fastify handler open. The 3600s clamp limits exposure.

## Suggested Follow-ups

- Consider using a separator other than `-` between project ID and agent name in compose project names (e.g., `__`) to make parsing unambiguous.
- Add a streaming/SSE variant of the drain endpoint for real-time progress in the dashboard.
- The 58 pre-existing test failures in agent sync and task dependencies should be investigated.
