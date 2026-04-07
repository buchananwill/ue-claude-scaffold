# Debrief 0050 -- Dashboard Server-Driven Filters

## Task Summary

Phase 2 of the task filter work: update the dashboard to forward all filter/sort params to the server instead of applying them client-side. The server's GET /tasks endpoint (updated in Phase 1) now accepts `status`, `agent`, `priority`, `sort`, and `dir` query params and returns `{ tasks, total }`.

## Changes Made

- **dashboard/src/hooks/useTasks.ts** -- Extended `useTasks` to accept `status` (string[]), `agent` (string[]), `priority` (number[]), `sort` (string), and `dir` (string) params. All are forwarded as comma-separated query params. All params included in `queryKey` for proper React Query refetching.

- **dashboard/src/hooks/useTaskFilters.ts** -- Changed `useTaskFiltersUrlBacked()` to no longer accept a `tasks` argument and no longer call `useFilteredTasks()`. It now only manages filter state (URL search params) and exposes `hasActiveFilters` directly. Exported new `TaskFiltersUrlBacked` type. Kept `useTaskFilters(tasks)` unchanged for client-side filtering (used by AgentDetailPage).

- **dashboard/src/pages/OverviewPage.tsx** -- Removed the `statusParam` useMemo workaround and the `useSearch` import. Now calls `useTaskFiltersUrlBacked()` first (no args), then passes all filter values to `useTasks()`. Pagination uses `tasks.data.total` (unchanged, was already correct).

- **dashboard/src/components/TasksPanel.tsx** -- Updated props to accept `TaskFilters | TaskFiltersUrlBacked`. Uses runtime `'displayedTasks' in filters` check to determine whether to use client-filtered `displayedTasks` or the server-filtered `tasks` prop directly. Updated empty-state logic: shows "No tasks match the current filters" when `hasActiveFilters` is true, "No tasks" otherwise.

## Design Decisions

- Used a union type (`TaskFilters | TaskFiltersUrlBacked`) for `TasksPanel.filters` rather than creating a shared interface, because the two hooks have fundamentally different return shapes. The runtime `'displayedTasks' in filters` check is minimal and type-safe.
- Kept `useTaskFilters` (client-side) completely unchanged since AgentDetailPage uses it for a small local subset of tasks where server-side filtering doesn't apply (it filters by agent name on a pre-fetched list).
- Page reset on filter change is handled naturally: all filter setters in `useTaskFiltersUrlBacked` already set `page: undefined` in the URL params.
- `uniqueAgents` and `uniquePriorities` are empty arrays in the server-filtered path. The agent/priority filter popovers still render but show no checkbox options. This is acceptable because the server handles the filtering -- the popovers serve mainly to set/clear filters via URL params, and the chips/badges still reflect active filters correctly.

## Build & Test Results

- **TypeScript check**: One pre-existing error in `RootLayout.tsx` (unrelated to this change). No new errors.
- **Vite build**: SUCCESS
- **Tests**: 102 passed, 0 failed (vitest run)

## Open Questions / Risks

- The agent and priority filter popovers in `TasksPanel` show empty checkbox lists when using server-side filtering, since `uniqueAgents`/`uniquePriorities` are derived from the current page of results in the client-side path. A future improvement could fetch distinct agents/priorities from a separate server endpoint to populate these popovers.
- The pre-existing TS error in `RootLayout.tsx` should be addressed separately.

## Suggested Follow-ups

- Add a server endpoint (e.g., `GET /tasks/facets`) that returns distinct agent names and priority values, so the filter popovers can be populated even in server-filtered mode.
- Fix the pre-existing TS error in `RootLayout.tsx`.
