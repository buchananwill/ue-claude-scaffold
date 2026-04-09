# Debrief 0147 -- Phase 10 Review Findings Fixes

## Task Summary

Fix all BLOCKING and WARNING findings from three parallel code reviews on Phase 10 (Drizzle migration of task-claim, task-lifecycle, task-files, and files routes).

## Changes Made

- **server/src/queries/tasks-claim.ts**: Fixed B1 (raw SQL `f2.claimant` -> `f2.claimant_agent_id`). Fixed B2 by splitting `agent` param into `agentId` (UUID, for `claimant_agent_id` comparisons) and `agentName` (string, for `result->>'agent'` comparisons) across `claimNextCandidate`, `countBlocked`, and `countDepBlocked`. Added JSDoc documenting which parameter type each function expects.
- **server/src/routes/tasks-claim.ts**: Fixed W1 by adding `agentsQ.getByName()` lookup at the start of both `/tasks/claim-next` and `/tasks/:id/claim` handlers. Resolved agent name to UUID, returning 404 if not found. Passed `agentId` to UUID-column functions (claim, claimFilesForAgent, checkAndClaimFiles, countBlocked) and `agentName` to name-based functions (blockersForTask, blockReasonsForTask, formatTaskWithFiles, countDepBlocked, validateSourcePathForClaim).
- **server/src/routes/tasks-lifecycle.ts**: Fixed B3 by removing dead `(row as any)` casts at lines 61 and 63.
- **server/src/routes/tasks-types.ts**: Fixed W2 by adding API-compat alias comments at `claimed_by`, `claimedBy` mapping sites.
- **server/src/routes/files.ts**: Fixed W2 by adding API-compat alias comment at `claimant` mapping site.
- **server/src/queries/task-files.ts**: Fixed W2 by adding API-compat alias comments at `claimant` select sites in `getFileConflicts` and `getFileConflictsForTask`.
- **server/src/queries/tasks-claim.test.ts**: Updated `claimNextCandidate` test calls from 3-arg to 4-arg signature.

## Design Decisions

- `result->>'agent'` stores agent names (verified via test fixtures like `{ agent: 'agent-1' }`), so comparisons against it use the agent name string.
- `claimant_agent_id` and `claimed_by_agent_id` are UUID columns referencing `agents.id`, so comparisons use the resolved UUID.
- `checkAndClaimFiles` receives the agentId (UUID) since it calls `getFileConflicts` and `claimFilesForAgent`, both of which operate on UUID columns.
- `blockersForTask` / `blockReasonsForTask` receive agent name since they compare against `result->>'agent'`.

## Build & Test Results

- Typecheck passes for all non-test files. Pre-existing test file errors (from other phases) are present but unrelated to these changes.

## Open Questions / Risks

- The test fixtures use plain strings like `'agent-a'` for both UUID and name comparisons (PGlite doesn't enforce FK constraints in test mode). This works but means tests don't fully validate the UUID vs name distinction.

## Suggested Follow-ups

- Consider storing agent name alongside UUID in the `result` jsonb, or adding an index/view that joins agent names for dependency resolution queries.
