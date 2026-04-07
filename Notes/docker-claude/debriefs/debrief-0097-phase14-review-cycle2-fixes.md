# Debrief 0097 -- Phase 14: Review findings cycle 2

## Task Summary

Fix all blocking and warning review findings from three reviewers on Phase 14 (stop.sh decomposition). Five blocking issues (B1-B4) and five warnings (W1-W5) were identified.

## Changes Made

- **server/src/routes/coalesce.ts** (modified):
  - B1: Removed redundant `?? false` on timedOut (line 122).
  - B3: Removed `body.projectId` override from drain endpoint; now uses `request.projectId` exclusively. Updated Body type annotation.
  - W1: Replaced in-loop `timedOut` tracking with post-loop `timedOut = !canCoalesce` for correct boundary handling.
  - W4: Removed `tx as any` casts in release endpoint; query functions now accept `DbOrTx`.
  - W5: Added comment noting Fastify's error handler sanitizes responses.

- **server/src/queries/coalesce.ts** (modified):
  - W4: Added `DbOrTx` type alias (`DrizzleDb | DrizzleTx`). Changed `countClaimedFiles`, `getPausedAgentNames`, `releaseAllFiles`, `resumePausedAgents` to accept `DbOrTx` instead of only `DrizzleDb`.

- **server/src/routes/coalesce.test.ts** (modified):
  - B3: Replaced "accepts projectId in body" test with "uses X-Project-Id header for project scoping" test.

- **stop.sh** (modified):
  - B2: Added regex validation for `team_project_id` after extraction from server response.
  - B3/W2: Replaced string-interpolated drain body with `jq -n` construction; removed `projectId` from body (uses X-Project-Id header only).
  - B4: Updated all four `_signal_and_stop_projects` calls to pass project_id as 3rd argument.
  - W3: Replaced `grep -oP 'claude-[^,]+'` with POSIX-compatible `grep -o 'claude-[^ ,]*'`.

- **scripts/lib/stop-helpers.sh** (modified):
  - B4: Added `project_id` as 3rd parameter to `_signal_and_stop_projects`. When non-empty, extracts agent name via `${project#claude-${project_id}-}`. When empty, skips signal step (drain already paused agents server-side; default stop is a hard kill).

## Design Decisions

1. **B4 approach**: Rather than querying the server for agent names when project_id is unknown, the simplest correct fix is to skip the signal step entirely. In default mode (stop all) the containers detect shutdown on their own. In drain mode, agents are already paused server-side.

2. **W1 approach**: Instead of tracking timedOut inside the loop (which has a race at the boundary), we determine it after the loop from the final canCoalesce check. This is simpler and always correct.

3. **W4 approach**: Updated the query functions to accept `DbOrTx` rather than casting at call sites. This matches the pattern used in `queries/rooms.ts`, `queries/chat.ts`, and `queries/teams.ts`.

## Build & Test Results

- `npm run build` in server/: SUCCESS
- `bash -n stop.sh`: SUCCESS
- `bash -n scripts/lib/stop-helpers.sh`: SUCCESS
- Coalesce tests: 19/19 PASS

## Open Questions / Risks

None. All review findings addressed.

## Suggested Follow-ups

None beyond those already noted in debrief-0096.
