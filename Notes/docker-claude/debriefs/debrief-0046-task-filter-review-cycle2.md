# Debrief 0046 -- Task Filter Review Cycle 2 Fixes

## Task Summary

Fix all BLOCKING and WARNING items from Phase 1 Review Cycle 2 of 5. These cover unused imports, unsafe `as any` casts, missing input validation, and missing tests in the task routes.

## Changes Made

- **server/src/queries/tasks-core.ts** -- Added `VALID_TASK_STATUSES` constant array export.
- **server/src/routes/tasks.ts** -- Removed unused `TaskDbRow` import. Removed all `(row as any)` / `(row as any).source_path` casts in PATCH handler, using direct camelCase property access. Added status validation against `VALID_TASK_STATUSES`. Added empty-segment validation for status and agent filters (matching priority behavior). Added cardinality limit (50) for status, agent, and priority arrays. Added agent name regex validation via `AGENT_NAME_RE`. Added `dir requires sort` validation. Simplified `priorityArr` ternary.
- **server/src/routes/tasks-claim.ts** -- Removed `as any` casts for `project_id` and `source_path` fallbacks. Simplified `validateSourcePathForClaim` type signature to remove dual snake_case/camelCase property alternatives.
- **server/src/routes/tasks.test.ts** -- Added 6 new tests: dir-without-sort returns 400, sort-without-dir defaults ascending, invalid status returns 400, status empty segments returns 400, agent empty segments returns 400, invalid agent name returns 400.

## Design Decisions

- The `validateSourcePathForClaim` function signature was narrowed to only accept camelCase properties since Drizzle always returns camelCase. This is consistent with the STYLE-B2/B3 fixes.
- Used `task.sourcePath!` (non-null assertion) in the claim error path because `validateSourcePathForClaim` returns `{ valid: true }` when sourcePath is null/undefined, so reaching the error branch guarantees it is non-null.

## Build & Test Results

- Build: SUCCESS (`npm run build`)
- Tests: All new tests pass. Pre-existing failures in "tasks with bare repo and agents" block due to missing git identity in container -- not related to these changes.
- tasks-core tests: 14/14 pass.

## Open Questions / Risks

- The pre-existing git identity issue in bare-repo tests is unrelated but could confuse CI.

## Suggested Follow-ups

- Fix the git identity issue in bare-repo test setup (pre-existing).
- Consider adding cardinality limits to other list endpoints for consistency.
