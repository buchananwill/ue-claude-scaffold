# Debrief 0054 -- Decomposition Review Fixes

## Task Summary

Fix 4 DRY violations and decomposition opportunities identified by the decomposition reviewer in `server/src/routes/tasks.ts` and `dashboard/src/` files.

## Changes Made

- **`dashboard/src/constants/task-statuses.ts`** (created): New single source of truth for `TASK_STATUSES` and `STATUS_LABELS`. `TASK_STATUSES` is derived from `STATUS_LABELS` keys.
- **`dashboard/src/hooks/useTaskFilters.ts`** (modified): Removed inline `TASK_STATUSES` definition. Re-exports from `constants/task-statuses.ts`.
- **`dashboard/src/components/TasksPanel.tsx`** (modified): Removed local `STATUS_LABELS` definition. Imports from `constants/task-statuses.ts`.
- **`dashboard/src/router.tsx`** (modified): Updated `TASK_STATUSES` import to use `constants/task-statuses.ts`.
- **`server/src/routes/tasks.ts`** (modified): Extracted `parseCommaFilter()` helper for comma-separated filter parsing (W1+W2). Extracted `parseTaskListQuery()` function that handles all GET /tasks validation (W4). The GET /tasks handler is now: parse -> if null return -> query -> format -> return.

## Design Decisions

- `TASK_STATUSES` in the dashboard is typed as `ReadonlyArray<string>` (derived from `Object.keys()`) rather than a const tuple. The previous `as const` tuple gave literal types, but since all consumers use `Set<string>` or iterate as strings, the broader type is sufficient and avoids a cast.
- `parseCommaFilter` returns `{ values, error }` rather than throwing, keeping the control flow explicit in the caller.
- `parseTaskListQuery` takes `FastifyReply` to send 400 errors directly and returns `null` on validation failure, matching the plan's prescribed API.

## Build & Test Results

- **Server build**: SUCCESS (`npm run build`)
- **Dashboard build**: SUCCESS (`npm run build`)
- **Server tests**: All `tasks routes` tests pass (50 tests). The `tasks with bare repo and agents` suite (54 tests) fails due to pre-existing git config issues in the Docker container (no git user.email configured), unrelated to these changes.

## Open Questions / Risks

- The `TASK_STATUSES` type change from `readonly ['pending', ...]` to `ReadonlyArray<string>` is a minor type widening. If any downstream code relied on the literal union type, it would need adjustment. Verified no such usage exists.

## Suggested Follow-ups

- Fix the Docker container git config so the bare-repo-dependent test suite can run.
