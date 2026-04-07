# Debrief 0045 - Task Filter Review Fixes (Cycle 1)

## Task Summary
Fix all BLOCKING and WARNING issues identified by three reviewers in the Phase 1 task filter implementation.

## Changes Made

- **server/src/queries/tasks-core.ts**: Exported `TaskDbRow` type and `DEFAULT_LIST_LIMIT` constant. Replaced `sql` template with `or()` combinator for the unassigned+named agent filter (SAFETY-W2). Changed default sort direction from `desc` to `asc` when `dir` is omitted (CORRECTNESS-W1). Used `DEFAULT_LIST_LIMIT` instead of hardcoded 100 (STYLE-W3).
- **server/src/queries/tasks-core.test.ts**: Changed `before`/`after` to `beforeEach`/`afterEach` so each test gets a fresh isolated DB (STYLE-B1). Each test now seeds its own data. Added test for default sort direction.
- **server/src/routes/tasks-types.ts**: Added `toTaskRow()` adapter function to convert Drizzle `TaskDbRow` to `TaskRow` without double-casting (STYLE-B2).
- **server/src/routes/tasks.ts**: Removed `project` query param from GET /tasks, using `request.projectId` exclusively (SAFETY-B1). Added `.filter(Boolean)` and empty-segment detection to priority parsing (CORRECTNESS-B1). Added 400 error for non-numeric priority values (STYLE-W1). Added upper bound of 500 on limit (SAFETY-W3). Used `DEFAULT_LIST_LIMIT` (STYLE-W3). Replaced `as unknown as TaskRow` casts with `toTaskRow()` (STYLE-B2).
- **server/src/routes/tasks-claim.ts**: Replaced `as unknown as TaskRow` casts with `toTaskRow()` (STYLE-B2).
- **server/src/routes/tasks.test.ts**: Changed test for non-numeric priority from "silently ignore" to "returns 400". Added tests for trailing and leading comma empty segments (CORRECTNESS-W2).

## Design Decisions
- The `toTaskRow()` adapter populates both snake_case and camelCase fields for full compatibility with the `pick()` function in `formatTask`.
- Empty segments in priority filter (from doubled/trailing/leading commas) return 400 rather than silently injecting 0, consistent with the STYLE-W1 philosophy.

## Build & Test Results
- Build: SUCCESS (`npm run build`)
- tasks-core.test.ts: 14/14 pass
- tasks.test.ts: Suite 1 ("tasks routes") 35/35 pass. Suite 2 ("tasks with bare repo and agents") 54 failures are pre-existing (git global identity not configured in container environment).

## Open Questions / Risks
- The "tasks with bare repo and agents" test suite failures are a pre-existing environment issue, not caused by these changes.

## Suggested Follow-ups
- Fix git global config in container test environment to unblock bare-repo test suite.
