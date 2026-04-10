# Debrief 0164 -- Phase 13 decomp: Import type, shared helper, error guard, naming

## Task Summary
Fix 5 consolidated review findings from the post-decomposition review (1 blocking, 4 warnings).

## Changes Made
- **server/src/routes/teams.ts**: Added `FastifyReply` to top-level import, removing inline `import('fastify').FastifyReply`. Renamed `validateBriefPath` to `rejectInvalidBriefPath` for clearer semantics. Updated JSDoc and both call sites.
- **server/src/routes/teams.test.ts**: Replaced local `registerTestAgents` implementation with the shared `registerAgent` helper from test-helper.ts.
- **server/src/routes/tasks-lifecycle.test.ts**: Replaced `as any` cast with proper generic type parameter on `res.json()`.
- **server/src/test-helper.ts**: Added status code guard in `registerAgent` that throws on non-200 responses.

## Design Decisions
- Kept the `registerTestAgents` wrapper function in teams.test.ts since it registers a specific set of 6 agents used across that test suite -- just replaced the internals to use the shared helper.

## Build & Test Results
- Build: SUCCESS (`npm run build`)
- Tests: 603 passed, 0 failed

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
