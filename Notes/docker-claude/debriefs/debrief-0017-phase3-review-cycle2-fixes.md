# Debrief 0017 -- Phase 3 Review Cycle 2 Fixes

## Task Summary

Fix four review findings from cycle 2 of Phase 3 (Update Server Routes to Use Helpers): add missing input validation on POST /tasks/:id/claim, standardize error format for targetAgents shape validation, move per-element targetAgents validation outside conditional block, and add test coverage for all new validation guards.

## Changes Made

- **server/src/routes/tasks-claim.ts** -- Added x-agent-name regex validation guard to POST /tasks/:id/claim handler, matching the existing guard in claim-next.
- **server/src/routes/tasks.ts** -- Replaced `reply.code(400).send({...})` with `reply.badRequest(...)` for targetAgents shape validation (line ~65). Moved per-element targetAgents name validation loop outside the `if (bareRepo)` block so it runs unconditionally after agentNames is populated. Also converted the "Unknown project" error in the same block to use `reply.badRequest()`.
- **server/src/routes/build.test.ts** -- Added two tests: POST /build and POST /test with malformed x-agent-name (path traversal pattern) verify rejection.
- **server/src/routes/tasks.test.ts** -- Added three tests: POST /tasks/claim-next with malformed x-agent-name returns 400, POST /tasks/:id/claim with malformed x-agent-name returns 400, POST /tasks with targetAgents containing invalid agent name returns 400.

## Design Decisions

- Build route returns validation errors as SpawnResult shape (success: false) rather than HTTP 400, matching the existing pattern in build.ts where agent name validation was already implemented this way.
- The targetAgents per-element validation now runs before any project resolution or git operations, which is both safer and more efficient.

## Build & Test Results

- Typecheck: clean (npx tsc --noEmit)
- Build tests: 17 passed, 0 failed
- Tasks tests: 96 passed, 0 failed

## Open Questions / Risks

None.

## Suggested Follow-ups

None.
