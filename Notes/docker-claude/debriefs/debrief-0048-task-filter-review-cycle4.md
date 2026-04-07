# Debrief 0048 - Task Filter Review Cycle 4 Fixes

## Task Summary

Phase 1 review fixes, cycle 4 of 5. Fix blocking test coverage gap for DELETE /tasks bulk-delete, safety issues with reflected error values and project-scoping, and a type correctness issue in toTaskRow.

## Changes Made

- **server/src/queries/tasks-core.ts** -- Added `projectId` parameter to `deleteByStatus` and scoped the delete query with `eq(tasks.projectId, projectId)`.
- **server/src/queries/tasks-core.test.ts** -- Updated existing `deleteByStatus` test to pass `projectId` argument and tightened the assertion from `>=2` to `===2`.
- **server/src/routes/tasks.ts** -- Passed `request.projectId` to `deleteByStatus` call. Truncated reflected user input in status validation errors to 32 chars (`s.slice(0, 32)`). Truncated each invalid priority value before joining in error message.
- **server/src/routes/tasks-types.ts** -- Changed `TaskRow.result` type from `string | null` to `unknown`. Removed unsafe cast in `toTaskRow`, using `row.result ?? null` with explanatory comment.
- **server/src/routes/tasks.test.ts** -- Added 5 tests for DELETE /tasks bulk-delete: happy path (completed), invalid status (400), missing status (400), protected status claimed (409), and project scoping verification. Tests placed in the first describe block to avoid pre-existing git identity failures in the bare-repo describe block.

## Design Decisions

- Placed all new DELETE tests in the `describe('tasks routes')` block rather than `describe('tasks with bare repo and agents')` because the bulk-delete endpoint does not require bare repo infrastructure, and the second block has pre-existing failures due to missing git identity config in the container.
- Added a 5th test beyond the 4 requested to verify the project-scoping fix (SAFETY-W2), since the instructions said "Update the new DELETE tests to verify project scoping."
- Changed `TaskRow.result` to `unknown` rather than `Record<string, unknown> | null` because `parseResult` already handles all runtime type variations (string, object, null) and `unknown` is the most accurate representation of what Drizzle returns for jsonb.

## Build & Test Results

- Build: SUCCESS (`npm run build`)
- tasks-core.test.ts: 14/14 pass
- tasks.test.ts: 49 pass (including all 5 new DELETE tests), 54 fail (all pre-existing git identity failures in the bare-repo describe block)

## Open Questions / Risks

- The 54 pre-existing test failures in `describe('tasks with bare repo and agents')` are caused by missing git identity configuration in the container environment. This is not related to this changeset.

## Suggested Follow-ups

- Fix the git identity issue in the test environment so the bare-repo tests pass.
- Consider adding `in_progress` to the protected statuses check in DELETE /tasks (currently only `claimed` and `in_progress` are blocked, which is correct -- just noting for completeness).
