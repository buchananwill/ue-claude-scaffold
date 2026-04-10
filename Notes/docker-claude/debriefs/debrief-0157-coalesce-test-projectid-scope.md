# Debrief 0157 -- Coalesce test claimTask projectId scope

## Task Summary
Phase 12 review cycle 3 fix: the `claimTask` helper in `coalesce.test.ts` updated the tasks table without a `projectId` predicate, unlike the files update which was correctly scoped. Fix was to add the missing predicate and correct the comment.

## Changes Made
- **server/src/routes/coalesce.test.ts** -- Added `eq(tasks.projectId, 'default')` to the `claimTask` helper's tasks update predicate, wrapped in `and()`. Updated the comment to accurately state both task and file updates are project-scoped.

## Design Decisions
None -- straightforward single-line fix with comment correction.

## Build & Test Results
- `npm run build` -- clean, no errors.
- `npx tsx --test src/routes/coalesce.test.ts` -- 20 passed, 0 failed.

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
