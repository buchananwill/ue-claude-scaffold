# Debrief 0145 -- Phase 9 decomp review cycle 2 fixes

## Task Summary
Apply 3 targeted fixes from post-decomposition review cycle 2: unify 404 response shape in rooms.ts, add ordering tiebreaker in queries/rooms.ts, and add projectId to a scoped test call in queries/rooms.test.ts.

## Changes Made
- **server/src/routes/rooms.ts** -- Changed two `reply.code(404).send({ error: 'unknown_agent' })` calls to `reply.notFound('unknown agent')` for consistency with the rest of the file.
- **server/src/queries/rooms.ts** -- Added `roomMembers.agentId` as secondary sort key to `getMembers` orderBy for deterministic ordering.
- **server/src/queries/rooms.test.ts** -- Added `projectId: 'default'` to the `listRooms` call in the member-filter test so the project-scoped code path is exercised.

## Design Decisions
None -- all changes were prescribed by the review findings.

## Build & Test Results
- Build: pre-existing errors in tasks-types.ts and teams.ts (unrelated to this change). No new errors in rooms files.
- Tests: 37/37 route tests pass, 9/9 query tests pass.

## Open Questions / Risks
- Pre-existing build errors in tasks-types.ts and teams.ts remain unresolved (out of scope).

## Suggested Follow-ups
None.
