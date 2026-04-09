# Debrief 0152 -- updateDeliverable + deleteRoom projectId scoping

## Task Summary
Two targeted fixes to enforce project-scoped queries:
1. Add `projectId` parameter to `updateDeliverable` in teams queries and pass it from the route handler.
2. Make `deleteRoom`'s `projectId` parameter required (was optional) and simplify the WHERE clause.

## Changes Made
- **server/src/queries/teams.ts** -- Added `projectId: string` parameter to `updateDeliverable`, included `eq(teams.projectId, projectId)` in WHERE via `and()`.
- **server/src/routes/teams.ts** -- Updated caller to pass `request.projectId` as second positional arg.
- **server/src/queries/rooms.ts** -- Changed `deleteRoom` signature from `projectId?: string` to `projectId: string`, removed conditional branching, always includes projectId in WHERE.

## Design Decisions
- Kept parameter ordering consistent with neighboring functions (`id`, `projectId`, then domain fields).

## Build & Test Results
- `npm run typecheck` passes with zero non-test-file errors. Test file errors are pre-existing and out of scope.

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
