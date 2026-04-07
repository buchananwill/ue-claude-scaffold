# Debrief 0044 - Server Task Filters

## Task Summary

Extend the server GET /tasks endpoint with server-side filtering (multi-status, agent, priority) and sorting (configurable column and direction) to fix issue #044 where client-side filtering after pagination produced broken results.

## Changes Made

- **server/src/queries/tasks-core.ts**: Changed `ListOpts.status` and `CountOpts.status` from `string` to `string[]` for multi-status IN-clause filtering. Added `agent?: string[]` (with `__unassigned__` sentinel for IS NULL), `priority?: number[]`, `sort?: SortColumn`, `dir?: 'asc' | 'desc'` fields. Extracted shared `buildFilterConditions()` helper used by both `list()` and `count()`. Added `VALID_SORT_COLUMNS` whitelist and `SortColumn` type export. Default sort remains `priority DESC, id ASC` when no sort param is provided.

- **server/src/queries/tasks-core.test.ts**: Updated two existing test calls from `status: 'pending'` to `status: ['pending']` to match the new array-based interface.

- **server/src/routes/tasks.ts**: Extended GET /tasks querystring type to include `agent`, `priority`, `sort`, `dir` params. Added parsing logic: comma-split for multi-value params, parseInt with NaN filtering for priority, whitelist validation for sort column, enum validation for dir. Passes parsed filters to both `list()` and `count()` so total reflects filtered count.

- **server/src/routes/tasks.test.ts**: Added 8 new tests covering: multi-status filter, priority filter, sort+dir, invalid sort column (400), invalid dir (400), agent __unassigned__ filter, non-numeric priority value ignored, filtered total matching filtered count.

## Design Decisions

- Used a shared `buildFilterConditions()` function to ensure `list()` and `count()` always apply identical filters. This is the core fix for the pagination/count mismatch.
- The `__unassigned__` sentinel for the agent filter uses `IS NULL` on `claimedBy`. When combined with named agents, it produces an OR condition.
- Non-numeric priority values are silently ignored (filtered out during parsing) rather than returning 400, since the plan specified "ignoring non-numeric values".
- Sort column is validated against a whitelist constant (`VALID_SORT_COLUMNS`). No raw query param values touch SQL.

## Build & Test Results

- TypeScript typecheck: PASS (clean, no errors)
- Tests: 33/33 pass in the main "tasks routes" suite (8 new). The "tasks with bare repo" suite has pre-existing failures due to missing git config in the container, unrelated to these changes.
- tasks-core unit tests: 13/13 pass.

## Open Questions / Risks

- The bare repo test suite failures are pre-existing and unrelated to this work.
- The `agent` filter combined with `__unassigned__` uses a raw SQL template for the OR condition. This is safe because the named agent values go through Drizzle's `inArray()` parameterization, but worth noting.

## Suggested Follow-ups

- Phase 2: Dashboard side needs to pass these new query params instead of doing client-side filtering.
- Consider adding an index on `claimedBy` if agent filtering becomes a hot path.
