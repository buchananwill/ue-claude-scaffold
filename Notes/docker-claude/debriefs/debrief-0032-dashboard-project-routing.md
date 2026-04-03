# Debrief 0032 - Dashboard Project-Scoped Routing

## Task Summary

Implement Phase 1 of the dashboard multi-tenancy UI plan. This is a dashboard-only change that restructures the route tree to insert `$projectId` as a layout route, adds a ProjectProvider context, modifies the API client to send `x-project-id` headers, and updates all nav links and navigate calls to include the project ID.

## Changes Made

- **dashboard/src/api/types.ts** - Added `Project` interface with id, name, engineVersion, seedBranch, buildTimeoutMs, testTimeoutMs, createdAt fields.
- **dashboard/src/api/client.ts** - Added module-level `currentProjectId` state with `setCurrentProjectId`/`getCurrentProjectId` exports. All API functions (`apiFetch`, `apiPost`, `apiPatch`, `apiDelete`) now include `x-project-id` header when set.
- **dashboard/src/contexts/ProjectContext.tsx** (new) - React context providing `{ projectId, projectName }`. Fetches project details from `GET /projects/:id`. Calls `setCurrentProjectId` on mount/change. Exports `useProject()` hook.
- **dashboard/src/layouts/RootLayout.tsx** (new) - Root layout that fetches `GET /projects`, auto-redirects to `/$id/` for single project, shows project picker cards for multiple projects, or "No projects configured" message.
- **dashboard/src/layouts/ProjectLayout.tsx** (new) - Intermediate layout that reads `$projectId` from route params, wraps children in `ProjectProvider` + `DashboardLayout`.
- **dashboard/src/router.tsx** - Restructured route tree: rootRoute -> RootLayout, projectRoute (`/$projectId`) -> ProjectLayout, all child routes parent to projectRoute. All validateSearch preserved.
- **dashboard/src/layouts/DashboardLayout.tsx** - Updated all NavLink `to` props to include `/$projectId` prefix with `params: { projectId }`. Uses `useProject()` for projectId. Active-path detection now strips project prefix.
- **dashboard/src/pages/MessagesPage.tsx** - All navigate calls updated to include `/$projectId` prefix and projectId param.
- **dashboard/src/pages/SearchPage.tsx** - Changed `useSearch({ from: '/search' })` to `useSearch({ strict: false })`. All navigate calls updated with projectId.
- **dashboard/src/pages/AgentDetailPage.tsx** - Back link and all navigate calls updated with projectId.
- **dashboard/src/pages/TaskDetailPage.tsx** - Back link, dependency links, and claimed-by link updated with projectId.
- **dashboard/src/components/AgentsPanel.tsx** - Agent name links updated with projectId.
- **dashboard/src/components/SearchBar.tsx** - All navigate calls (tasks, messages, agents, full search) updated with projectId.
- **dashboard/src/components/TaskDetailRow.tsx** - Blocked-by dependency links updated with projectId.
- **dashboard/src/components/TasksPanel.tsx** - Task title and agent links updated with projectId.
- **dashboard/src/components/TeamCard.tsx** - Chat room button link updated with projectId.

## Design Decisions

1. **ProjectLayout as separate file** - Rather than inlining the ProjectProvider into DashboardLayout, created a dedicated `ProjectLayout.tsx` that composes ProjectProvider around DashboardLayout. This keeps DashboardLayout focused on rendering the shell and avoids coupling it to route params directly.
2. **setCurrentProjectId via useEffect** - The ProjectProvider sets/clears the global project ID via useEffect with cleanup, ensuring the header is always in sync with the current project context.
3. **SearchPage strict: false** - Changed from `{ from: '/search' }` to `{ strict: false }` because the route path changed from `/search` to `/$projectId/search`. Using strict:false avoids hardcoding the full path.
4. **Active path detection** - DashboardLayout strips the project prefix from the current path to determine which nav item is active, making the logic independent of the project ID value.

## Build & Test Results

Pending initial build.

## Open Questions / Risks

- The `GET /projects` and `GET /projects/:id` endpoints must exist on the server for the RootLayout and ProjectProvider to work. These are not being created in this phase (dashboard-only change). The dashboard will show loading/error states until the server endpoints are available.
- TanStack Router type inference may produce warnings with the `as any` casts on params. These were already present in the original code and are preserved.

## Suggested Follow-ups

- Server-side: Implement `GET /projects` and `GET /projects/:id` endpoints.
- Add a "Switch project" link in the DashboardLayout header for multi-project setups.
- Consider caching the project list to avoid re-fetching on every root navigation.
