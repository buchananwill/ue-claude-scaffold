# Debrief 0052 -- Phase 2 Review Cycle 2 Fixes

## Task Summary

Fix all BLOCKING and WARNING items from Phase 2 review cycle 2, covering import extensions, agent filter source, JSDoc annotations, status enum sync, sentinel cross-references, and loading guard logic.

## Changes Made

- **dashboard/src/layouts/RootLayout.tsx** -- Changed `.ts` import extensions to `.js` (STYLE-B1).
- **dashboard/src/hooks/useAgents.ts** -- Changed `.ts`/`.tsx` import extensions to `.js` (discovered same issue).
- **dashboard/src/pages/OverviewPage.tsx** -- Derived `availableAgents` from `useAgents()` hook (fetches `/agents`) instead of from current page tasks (CORRECTNESS-B1). Always includes UNASSIGNED sentinel.
- **dashboard/src/hooks/useTaskFilters.ts** -- Added JSDoc to `useTaskFilters` warning against use with paginated data, and to `useTaskFiltersUrlBacked` clarifying it is the server-side variant (CORRECTNESS-B2). Added `'integrated'` and `'cycle'` to `TASK_STATUSES` with sync comment (SAFETY-W1). Added cross-reference comment on `UNASSIGNED` sentinel explaining server recognition (SAFETY-W2).
- **dashboard/src/hooks/useTasks.ts** -- Added cross-reference comment near the agent filter parameter explaining the UNASSIGNED sentinel (SAFETY-W2).
- **dashboard/src/components/TasksPanel.tsx** -- Added `integrated` and `cycle` to `STATUS_LABELS` with sync comment (SAFETY-W1). Simplified loading guard to `isFetching && displayedTasks.length === 0` so it works correctly with `keepPreviousData` (CORRECTNESS-W1).

## Design Decisions

- For the agent filter (CORRECTNESS-B1), always include UNASSIGNED in the list so users can filter for unassigned tasks even when all registered agents have names. The previous approach only showed UNASSIGNED if the current page had null claimedBy tasks.
- Fixed `.ts`/`.tsx` extensions in `useAgents.ts` even though not explicitly listed -- same class of issue as STYLE-B1 and would cause runtime failures.

## Build & Test Results

- `npm run build` in `dashboard/` -- SUCCESS (tsc + vite build clean).

## Open Questions / Risks

- None.

## Suggested Follow-ups

- None.
