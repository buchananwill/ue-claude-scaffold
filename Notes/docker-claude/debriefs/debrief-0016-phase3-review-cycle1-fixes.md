# Debrief 0016 -- Phase 3 Review Cycle 1 Fixes

## Task Summary
Fix six review findings from Phase 3 (Update Server Routes to Use Helpers): double blank line in branch-naming.ts, deprecated rmdirSync in tests, missing per-item targetAgents validation, missing x-agent-name header validation, stale test worktree branch names, and a stale comment in sync.ts.

## Changes Made
- **server/src/branch-naming.ts** -- Removed extra blank line between JSDoc and first comment (Style W1).
- **server/src/routes/build.test.ts** -- Replaced `rmdirSync` with `rmSync` (Style W2). Updated agent worktree insertions from `docker/test-agent` to `docker/default/test-agent` and corresponding assertions (Correctness B1).
- **server/src/routes/tasks.test.ts** -- Replaced `rmdirSync` with `rmSync` (Style W2).
- **server/src/routes/sync.ts** -- Added per-item regex validation for targetAgents before calling `agentBranchFor` (Safety B1). Updated stale comment from `docker/current-root` to `docker/{projectId}/current-root (via seedBranchFor)` (Correctness W1).
- **server/src/routes/tasks.ts** -- Added per-item regex validation for targetAgents before calling `agentBranchFor` (Safety B1).
- **server/src/routes/build.ts** -- Added `x-agent-name` header format validation in both `/build` and `/test` handlers (Safety W1).
- **server/src/routes/tasks-claim.ts** -- Added `x-agent-name` header format validation in `/tasks/claim-next` handler (Safety W1).

## Design Decisions
- For build.ts agent name validation, returned a SpawnResult-shaped error rather than using reply.badRequest, since the build routes return SpawnResult objects and do not use Fastify error helpers.
- For tasks-claim.ts, added `reply` parameter to the claim-next handler signature to enable `reply.badRequest()`.
- Did NOT modify build.ts syncWorktree to use agentBranchFor, per explicit instruction that the current DB-read behavior is correct.

## Build & Test Results
- TypeScript typecheck: PASS (npx tsc --noEmit)
- Tests: 136 passed, 0 failed

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
