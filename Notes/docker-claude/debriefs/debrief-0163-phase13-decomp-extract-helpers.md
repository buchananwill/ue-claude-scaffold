# Debrief 0163 -- Phase 13 decomp: Extract helpers, reduce test duplication

## Task Summary
Fix 5 decomposition review findings (W1-W5) focused on code duplication and test file bloat.

## Changes Made
- **server/src/routes/teams.ts** -- Extracted `validateBriefPath()` helper function, replaced two inline validation blocks with calls to it.
- **server/src/routes/teams.test.ts** -- Wrapped all 8 describe blocks in a single outer `describe('teams routes', ...)` with shared beforeEach/afterEach, removing 8 duplicate setup/teardown blocks.
- **server/src/test-helper.ts** -- Added shared `registerAgent(app, name, projectId?)` helper that POSTs to /agents/register and returns the agent UUID.
- **server/src/routes/tasks-claim.test.ts** -- Replaced local `registerAgent` with import from test-helper.
- **server/src/routes/tasks-lifecycle.test.ts** -- Replaced local `registerAgent` with import from test-helper. Hoisted `createCompletedTaskWithAgent` to parent describe scope, removing 2 duplicate definitions.
- **server/src/routes/ownership.test.ts** -- Replaced local `registerAgent` with import from test-helper. Adapted agentIds population to use return value.
- **server/src/routes/ubt.test.ts** -- Replaced local `registerAgent` with import from test-helper. Adapted agentIds population to use return value.
- **server/src/routes/tasks-deps.test.ts** -- Removed pagination, x-agent-name validation, and targetAgents validation tests (not dependency-related).
- **server/src/routes/tasks-validation.test.ts** -- New file containing the extracted pagination, x-agent-name validation, and targetAgents validation tests.

## Design Decisions
- The shared `registerAgent` returns the UUID string so callers like ownership.test.ts and ubt.test.ts that cache agent UUIDs can use the return value directly.
- For ownership.test.ts, the `agentIds` record is cleaned at the start of each beforeEach to avoid stale data between tests.
- The `validateBriefPath` helper returns `true` when invalid (caller should return early), matching the pattern suggested in the review.

## Build & Test Results
- Build: SUCCESS (`npm run build`)
- Tests: 603 passed, 0 failed, 0 skipped

## Open Questions / Risks
None.

## Suggested Follow-ups
- The `registerTestAgents` helper in teams.test.ts could also be migrated to test-helper.ts if more test files need it.
