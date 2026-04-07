# Debrief 0049 -- Phase 1 Final Fixes

## Task Summary
Apply two trivial final fixes for Phase 1: truncate the `sort` value in the invalid-sort error message, and add a test for `in_progress` status returning 409 on bulk delete.

## Changes Made
- **server/src/routes/tasks.ts** -- Changed `${sort}` to `${sort.slice(0, 32)}` in the invalid sort column error message to match the truncation pattern used elsewhere.
- **server/src/routes/tasks.test.ts** -- Added test `returns 409 for in_progress status (protected)` after the existing `claimed` status 409 test.

## Design Decisions
None -- both changes were prescribed exactly.

## Build & Test Results
- Build: SUCCESS (`npm run build`)
- Tests: Both new/modified tests pass. 54 pre-existing failures in the "tasks with bare repo and agents" suite (bare repo initialization errors unrelated to this work).

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
