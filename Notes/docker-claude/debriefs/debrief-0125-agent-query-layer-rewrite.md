# Debrief 0125 — Phase 6: Agent-referencing query layer rewrite

## Task Summary

Rewrote four query files that reference agent columns to use UUID foreign keys (`agent_id`) instead of text agent names, and added required `projectId` parameters for project scoping. UBT queries were made host-level (no project scoping).

## Changes Made

- **server/src/queries/tasks-lifecycle.ts** — All functions now take `projectId` as a required parameter. `releaseByAgent` accepts `(db, projectId, agentId)` using UUID. `releaseAllActive` accepts `(db, projectId)`. All `claimedBy` references replaced with `claimedByAgentId`. `claim` takes `agentId` instead of `agent`. `integrateBatch` matches on `claimedByAgentId` instead of JSON result field. `getCompletedByAgent` also matches on `claimedByAgentId`. All where-clauses include `projectId` filtering.

- **server/src/queries/files.ts** — `releaseByClaimant` renamed to `releaseByClaimantAgentId(db, projectId, agentId)`. `releaseAll` takes `(db, projectId)`. `ListOpts` changed from `claimant` to `claimantAgentId`. All `files.claimant` references replaced with `files.claimantAgentId`. Removed unused `sql` import; added `isNotNull` for `releaseAll` scoping.

- **server/src/queries/coalesce.ts** — All functions changed from optional `projectId?` to required `projectId`. `countActiveTasksForAgent` and `getOwnedFiles` take `agentId` (UUID) instead of `agent` (text name). Column references updated to `tasks.claimedByAgentId` and `files.claimantAgentId`. `getInFlightTasks` return type updated to `claimedByAgentId`.

- **server/src/queries/ubt.ts** — Removed all `projectId` parameters (UBT is host-level). `getLock/releaseLock` keyed by `hostId` (default `'local'`). `acquireLock` uses `onConflictDoUpdate` on `ubtLock.hostId`. All `holder` references changed to `holderAgentId`. `ubtQueue.agent` changed to `ubtQueue.agentId`. `enqueue` takes `(db, agentId, priority)` — no project. `dequeue/getQueue/findInQueue` take no project parameter. `isAgentRegistered` matches on `agents.id` instead of `agents.name`. Removed unused `gt` import.

## Design Decisions

- `integrateBatch` was changed from matching on `result->>'agent'` (JSON text field) to matching on `tasks.claimedByAgentId` (UUID FK). The JSON result field was a proxy for agent ownership; the FK is the authoritative source.
- `getCompletedByAgent` similarly matches on `claimedByAgentId` rather than the JSON result field.
- `releaseAll` in files.ts scopes to project and only touches rows with a non-null claimant, matching the pattern in coalesce.ts.
- `dequeue` in ubt.ts removes project scoping from the raw SQL subquery since UBT is host-level.

## Build & Test Results

- Targeted typecheck of the four modified files: zero errors.
- Full typecheck shows errors only in caller files (routes, test files, other query files) — expected and acceptable per acceptance criteria.

## Open Questions / Risks

- Callers of these functions throughout routes and test files need updating to match new signatures — this is expected follow-up work for subsequent phases.
- `integrateBatch` behavior change (from JSON matching to FK matching) may need caller updates if any caller relied on the old JSON-based lookup.

## Suggested Follow-ups

- Update all route handlers that call these four query modules to pass the new parameters.
- Update all test files for these queries to use new signatures and column names.
- Update `tasks-claim.ts` and `task-files.ts` which still reference old column names (`files.claimant`, `tasks.claimedBy`).
