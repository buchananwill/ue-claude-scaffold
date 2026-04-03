# Debrief 0032 - Dashboard Project-Scoped Routing

## Task Summary

Phase 1 implementation of dashboard multi-tenancy routing, plus review cycle 1 fixes addressing 6 BLOCKING and 10 WARNING issues identified across three code reviews.

## Changes Made (Review Cycle 1 Fixes)

### BLOCKING Fixes

- **dashboard/src/api/types.ts** - Renamed `requested_at` to `requestedAt` in `UbtQueueEntry` interface (STYLE B1).
- **dashboard/src/api/client.ts** - Removed global mutable `currentProjectId` variable, `setCurrentProjectId`, and `getCurrentProjectId`. Added optional `projectId` parameter to `apiFetch`, `apiPost`, `apiPatch`, `apiDelete`. When provided, includes `x-project-id` header. Also: `extractError` now returns generic "Server error" for 5xx responses (SAFETY B1 + CORRECTNESS B1 + SAFETY W2).
- **dashboard/src/contexts/ProjectContext.tsx** - Removed `useEffect` that set/cleared global state. Added `projectId` format validation (`/^[a-zA-Z0-9_-]{1,64}$/`) with error UI for invalid IDs. Pass `projectId` to `apiFetch` call (SAFETY B2).
- **dashboard/src/layouts/RootLayout.tsx** - Replaced `useEffect` + `navigate()` redirect with `<Navigate>` component for single-project case, eliminating blank flash. Removed unused `Outlet` import. Added comment documenting that `/projects` endpoint does not require `x-project-id` header (CORRECTNESS B2 + CORRECTNESS W3 + STYLE W1).
- **dashboard/src/layouts/ProjectLayout.tsx** - Changed `useParams({ strict: false }) as { projectId: string }` to `useParams({ from: '/$projectId' })`, removing manual cast (CORRECTNESS B3).

### WARNING Fixes

- **dashboard/src/hooks/useTaskFilters.ts** - Added explanatory comment for `prev: any` cast in `setPage`. Added JSDoc on `useTaskFiltersUrlBacked` stating route constraint (STYLE W1 + CORRECTNESS W4).
- **dashboard/src/pages/TaskDetailPage.tsx** - Replaced three `fontSize: '0.875rem'` instances with `<Text fz="sm">` wrappers around Link components. Used strict params via `useParams({ from: '/$projectId/tasks/$taskId' })` (STYLE W2).
- **dashboard/src/pages/AgentDetailPage.tsx** - Replaced `fontSize: '0.875rem'` with `<Text fz="sm">` wrapper. Used strict params. Added guard for empty `agentName` (STYLE W2 + CORRECTNESS W1).
- **dashboard/src/components/TeamCard.tsx** - Replaced `background: 'var(--mantine-color-dark-6)'` with `bg="var(--mantine-color-default)"` and `fontSize: 'var(--mantine-font-size-sm)'` with `fz="sm"` prop (STYLE W3).
- **dashboard/src/hooks/useTask.ts** - Changed `!isNaN(id)` to `Number.isInteger(id) && id > 0` (SAFETY W1).
- **dashboard/src/hooks/useTaskActions.ts** - Added `Number.isInteger(id) && id > 0` guards to `handleRelease` and `handleDelete` (SAFETY W1).
- **dashboard/src/router.tsx** - Validated `highlight` search param as positive integer in `messagesChannelRoute` (SAFETY W3).
- **dashboard/src/components/TaskDetailRow.tsx** - Changed `colSpan={7}` to `colSpan={8}` (CORRECTNESS W2).

### Hook Updates (projectId plumbing)

All hooks that call API functions were updated to get `projectId` from `useProject()` and pass it through:
- useAgents.ts, useAgent.ts, useTasks.ts, useTask.ts, useTaskActions.ts
- useMessages.ts, useHealth.ts, useUbtStatus.ts, useBuildHistory.ts
- useSearch.ts, useRooms.ts, useRoomDetail.ts, useChatMessages.ts
- useTeams.ts, useTeamDetail.ts

Components that call API functions directly were also updated:
- AgentsPanel.tsx, ChatTimeline.tsx, OverviewPage.tsx

## Design Decisions

1. **Explicit projectId parameter vs hook abstraction** - Chose to add an optional `projectId` parameter to each API function rather than creating a wrapper hook. This is simpler, keeps the API surface flat, and avoids breaking the existing function signatures (the parameter is optional).
2. **Validation in ProjectProvider** - Format validation on `projectId` is done in `ProjectProvider` rather than `ProjectLayout` because `ProjectProvider` is the single entry point for all project-scoped rendering. Invalid IDs render an error UI immediately.
3. **Navigate component for redirect** - Using `<Navigate>` instead of `useEffect` + `navigate()` eliminates the flash-of-wrong-content because the redirect happens synchronously in the render phase.
4. **Text wrapper for font sizes** - Wrapped `<Link>` components in `<Text fz="sm">` rather than using `Anchor component={Link}` because the Mantine Anchor polymorphic component doesn't properly forward TanStack Router Link types, causing TS errors.

## Build & Test Results

TypeScript type check (`npx tsc -b --noEmit`) passes cleanly with no errors.

## Open Questions / Risks

- The `as any` cast on the `Navigate` component in `RootLayout.tsx` is required because TanStack Router types the `Navigate` component against the root route's params, but we navigate to a child route. This is a known TanStack Router typing limitation.
- Query keys now include `projectId` to properly scope caches per project, which means switching projects invalidates all cached data (correct behavior).

## Suggested Follow-ups

- Server-side: Implement `GET /projects` and `GET /projects/:id` endpoints if not already done.
- Consider adding a project-scoped query client wrapper to automatically scope all query keys.
