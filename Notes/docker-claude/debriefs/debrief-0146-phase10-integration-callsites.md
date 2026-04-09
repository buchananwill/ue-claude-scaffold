# Debrief 0146 -- Phase 10: Integration -- remaining callsites

## Task Summary

Update all non-test callsites of renamed or removed query functions across the server codebase so that `npm run typecheck` passes for non-test files. This includes threading `projectId` through call chains, replacing removed functions like `agentsQ.getProjectId`, updating column references from old names (e.g. `claimedBy` -> `claimedByAgentId`, `claimant` -> `claimantAgentId`, `holder` -> `holderAgentId`), and removing `projectId` from UBT calls (host-level, not project-scoped).

## Changes Made

- **server/src/queries/tasks-core.ts** -- Updated `SORTABLE_COLUMNS` and `buildFilterConditions` to use `tasks.claimedByAgentId` instead of the dropped `tasks.claimedBy` column.
- **server/src/queries/task-files.ts** -- Replaced all references to `files.claimant` with `files.claimantAgentId`; updated `.set()` call to use `claimantAgentId`.
- **server/src/queries/tasks-claim.ts** -- Fixed raw SQL references from `f.claimant` to `f.claimant_agent_id` (3 occurrences in raw SQL strings).
- **server/src/queries/projects.ts** -- Removed `ubtLock` and `ubtQueue` from `hasReferencingData` check since those tables no longer have `projectId` columns; cleaned up unused imports.
- **server/src/routes/tasks-types.ts** -- Updated `toTaskRow` to read `claimedByAgentId` from DB rows instead of removed `claimedBy`.
- **server/src/routes/coalesce.ts** -- Updated `r.claimedBy` -> `r.claimedByAgentId` in response mapping; fixed argument order and switched from agent name to agent UUID for `getOwnedFiles` and `countActiveTasksForAgent` calls.
- **server/src/routes/files.ts** -- Updated `filesQ.list` opts from `claimant` to `claimantAgentId`; mapped response from `r.claimantAgentId`.
- **server/src/routes/build.ts** -- Removed `resolveProjectIdForAgent` helper (used `agentsQ.getProjectId`); refactored `resolveProjectForAgent` and `prepareBuildOrTest` to accept `projectId` parameter from `request.projectId`; updated `checkLock` to use `lock.holderAgentId` instead of `lock.holder`; removed `projectId` from `ubtQ.getLock` call; added `projectId` parameter to `syncWorktree` and threaded through `agentsQ.getWorktreeInfo`.
- **server/src/routes/tasks-claim.ts** -- Replaced `agentsQ.getProjectId` with `request.projectId`; added `projectId` to `agentsQ.getWorktreeInfo`, `tasksLifecycleQ.claim`, `tasksLifecycleQ.release`, and `tasksLifecycleQ.updateProgress` calls.
- **server/src/routes/tasks-lifecycle.ts** -- Added `request.projectId` to all `tasksLifecycleQ` calls (`complete`, `fail`, `reset`, `integrate`, `integrateBatch`, `integrateAll`); fixed `integrateAll` handler to accept `request` parameter.
- **server/src/routes/teams.ts** -- Added `agentsQ` import; resolve agent names to UUIDs via `getByName` before passing to `createWithRoom`; changed GET response from `m.agentName` to `m.agentId`.
- **server/src/git-utils.ts** -- Passed `projectId` to `agentsQ.getActiveNames` call (already available in function scope).

## Design Decisions

- **No fallback to 'default'**: Per the plan, all `projectId` values come from `request.projectId` -- never hardcoded as `'default'`.
- **UBT calls stripped of projectId**: UBT is host-level (single mutex per host), so `getLock` uses the default `hostId = 'local'` without any project scoping.
- **Agent name -> UUID resolution in teams**: Added explicit `getByName` lookup before team member creation, returning a 400 error if an agent is not found. This validates agents exist before creating team membership records.
- **Raw SQL column names**: Fixed `tasks-claim.ts` raw SQL to use `claimant_agent_id` instead of dropped `claimant` column, even though this doesn't cause typecheck errors (it would cause runtime SQL errors).

## Build & Test Results

- `npm run typecheck` -- 0 errors in non-test files. 112 errors remain in test files (Phase 12 scope).

## Open Questions / Risks

- The `tasks-claim.ts` raw SQL queries reference `f.claimant` which was the old column name. Fixed to `f.claimant_agent_id`. However, these queries also pass the agent `name` string (from the HTTP header) for comparison with UUID columns -- this is a semantic mismatch that may need addressing in a later phase when the claim-next flow is fully migrated to use agent UUIDs.
- `coalesce.ts` route's `/coalesce/status` endpoint passes `row.name` and `row.id` -- verified that `getOwnedFiles` and `countActiveTasksForAgent` now correctly receive UUID via `row.id`.
- Teams GET endpoint now returns `agentId` (UUID) instead of `agentName` -- this is a breaking API change for dashboard consumers that may need a name lookup or JOIN.

## Suggested Follow-ups

- Phase 12: Update all 112 test file errors to match new signatures.
- Consider adding agent name resolution in the claim-next SQL queries to properly match agent UUIDs.
- Dashboard team detail view may need updating to display agent names from UUIDs.
