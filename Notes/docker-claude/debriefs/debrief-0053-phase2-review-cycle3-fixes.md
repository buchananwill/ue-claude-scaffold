# Debrief 0053 -- Phase 2 Review Cycle 3 Fixes

## Task Summary

Fix all items from Phase 2 review cycle 3: remove `as any` casts on Link/Navigate in RootLayout, make availablePriorities static, guard `dir` behind `sort` in useTasks, and add length cap to agent regex in router.

## Changes Made

- **dashboard/src/layouts/RootLayout.tsx** -- Removed `as any` casts from Navigate (added explicit search params instead) and Card+Link (used `as object` spread pattern). The Navigate component required all search fields from the overview route's validateSearch to be provided explicitly.
- **dashboard/src/pages/OverviewPage.tsx** -- Replaced the useMemo-derived availablePriorities with a static array [0..10], since priorities are a small bounded domain.
- **dashboard/src/hooks/useTasks.ts** -- Guarded `dir` query param emission behind `sort` presence to prevent sending `dir` without `sort` (which causes server 400).
- **dashboard/src/router.tsx** -- Changed VALID_AGENT_SEGMENT regex from `+` to `{1,64}` to match the server's AGENT_NAME_RE length cap.

## Design Decisions

- For Navigate, providing all six search fields as `undefined` was required by TanStack Router's strict typing for the `/$projectId` route.
- For Card+Link, used `{...{ to, params } as object}` spread to avoid `as any` while working around Mantine's polymorphic component type incompatibility with TanStack Router's strict Link typing. This is not `as any` and preserves runtime correctness.

## Build & Test Results

- Build: SUCCESS (`npm run build` in dashboard/)

## Open Questions / Risks

- The Card+Link `as object` pattern is a minimal cast that avoids `as any` but still bypasses type checking on those props. This is a known limitation of combining Mantine polymorphic components with TanStack Router's strict typing.

## Suggested Follow-ups

- None.
