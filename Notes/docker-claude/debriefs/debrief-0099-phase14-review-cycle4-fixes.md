# Debrief 0099 -- Phase 14 Review Cycle 4 Fixes

## Task Summary

Fix six WARNING-level review findings from Phase 14 Cycle 4 across coalesce queries, coalesce routes, coalesce tests, and stop.sh.

## Changes Made

- **server/src/queries/coalesce.ts** -- Added optional `projectId` parameter to `countActiveTasksForAgent`. Replaced `conditions` array + `and(...conditions)` pattern with direct ternary `projectId ? and(baseCond, eq(...)) : baseCond` across all functions.
- **server/src/routes/coalesce.ts** -- Updated `countActiveTasksForAgent` call site to pass `projectId`. Changed `pollError` response to opaque string; moved detailed error to `request.log.error`.
- **server/src/routes/coalesce.test.ts** -- Added test for `POST /coalesce/drain` with absent body (no payload, no Content-Type) to verify the `(request.body ?? {})` guard.
- **stop.sh** -- Added defense-in-depth TEAM_ID re-validation before URL usage. Removed dead `drained` variable assignment.

## Design Decisions

- Used `request.log.error` instead of `fastify.log.error` in the drain handler since request-scoped logging includes request context (request ID, etc.), which is more useful for debugging.
- The opaque error string matches the exact wording from the review instructions.

## Build & Test Results

- Build: SUCCESS (`npm run build`)
- Tests: 20 passed, 0 failed (`npx tsx --test src/routes/coalesce.test.ts`)
- Shell validation: `bash -n stop.sh` passed

## Open Questions / Risks

None.

## Suggested Follow-ups

None.
