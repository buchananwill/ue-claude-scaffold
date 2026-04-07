# Debrief 0098 -- Phase 14 Review Cycle 3 Fixes

## Task Summary

Fix all blocking and warning findings from the Phase 14 Cycle 3 review of stop.sh decomposition and coalesce routes.

## Changes Made

- **server/src/queries/coalesce.ts**: Replaced 3 inline `sql` template literals for active task status with `inArray(tasks.status, ACTIVE_STATUSES)`. Made `ACTIVE_STATUSES` use `as const`. Added explicit return types to 6 exported functions. Kept `sql` import since it is still used in `pausePumpAgents`.
- **server/src/routes/coalesce.ts**: Wrapped the drain polling `while` loop in try/catch. On error, logs via Fastify logger and includes an `error` field in the response.
- **server/src/routes/coalesce.test.ts**: Improved idempotency test to assert 200 status on both calls and verify agent status via GET endpoint, rather than relying on the pause response including already-paused agents.
- **stop.sh**: Changed PROJECT_ID regex from `^[a-zA-Z0-9_-]+$` to `^[a-zA-Z0-9_-]{1,64}$` for length cap consistency.
- **scripts/lib/stop-helpers.sh**: Added regex guard `^[a-zA-Z0-9_-]{1,64}$` at top of `_signal_stop`. Fixed misleading dependency comment to only mention COMPOSE_CMD.

## Design Decisions

- Kept `sql` in the drizzle-orm import because `pausePumpAgents` uses a NOT IN clause that has no clean `notInArray` equivalent without also refactoring that function (out of scope).
- The try/catch in the drain loop sets a `pollError` string field on the response rather than throwing, allowing the caller to see partial drain results even if polling failed mid-way.

## Build & Test Results

- Build: SUCCESS (`npm run build`)
- Tests: 19 passed, 0 failed (`npx tsx --test src/routes/coalesce.test.ts`)
- Shell syntax: OK (`bash -n stop.sh`, `bash -n scripts/lib/stop-helpers.sh`)

## Open Questions / Risks

None.

## Suggested Follow-ups

- Consider replacing the `sql` NOT IN clause in `pausePumpAgents` with a Drizzle `notInArray` helper for full consistency.
