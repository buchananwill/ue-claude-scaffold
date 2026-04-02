# Plan: Dashboard Multi-Tenancy UI

> **Depends on:** `plans/server-multi-tenancy.md` (all phases complete). This plan makes NO changes to the server or backend; it only modifies the dashboard presentation layer.

**Goal:** Make the dashboard project-aware with project-scoped routing, data fetching, and UI improvements.

**Tech Stack:** React, TanStack Router, TanStack Query, Mantine UI, Vite.

---

## Context

After the server plan is complete:
- A `GET /projects` endpoint returns all project definitions from the DB.
- All server endpoints accept `x-project-id` headers and scope data accordingly.
- Branches are namespaced as `docker/{project-id}/...` (invisible to the UI, but the project ID is the scoping key).

The dashboard currently has no project awareness: no `x-project-id` header sent, no project selector, no route parameterisation.

---

## Phase 1: Project-Scoped Routing and Data Fetching

### 1.1 Route Tree Restructuring

Restructure the route tree to insert `$projectId` as a layout route:

```
/ (rootRoute -> RootLayout)
  /$projectId (projectRoute -> DashboardLayout)
    /                    -> OverviewPage
    /messages            -> MessagesPage
    /messages/$channel   -> MessagesPage
    /tasks/$taskId       -> TaskDetailPage
    /agents/$agentName   -> AgentDetailPage
    /logs                -> BuildLogPage
    /chat                -> ChatPage
    /teams               -> TeamsPage
    /search              -> SearchPage
```

Root route behaviour: fetch `GET /projects`. If single project, auto-redirect to `/$id/`. If multiple, render a project picker.

**Files:** `dashboard/src/router.tsx`

### 1.2 ProjectProvider Context

A React context at the `$projectId` layout level that:
- Reads `$projectId` from route params
- Fetches project details from `GET /projects/:id`
- Provides `{ projectId, projectName }` to all children via `useProject()` hook

**Files:**
- New: `dashboard/src/contexts/ProjectContext.tsx`
- Modify: `dashboard/src/layouts/DashboardLayout.tsx`

### 1.3 API Client: `x-project-id` Header

All `apiFetch`/`apiPost`/`apiPatch`/`apiDelete` calls include `x-project-id` from context. Either:
- Accept `projectId` as a parameter, or
- Read from a module-level store set by the provider

**Files:** `dashboard/src/api/client.ts`

### 1.4 Project Type Definition

Add the `Project` type to match the server's `GET /projects/:id` response shape.

**Files:** `dashboard/src/api/types.ts`

### 1.5 Nav Link Updates

All `<Link>` components in `DashboardLayout` and page components must include the `projectId` param so URLs stay project-scoped.

**Files:**
- `dashboard/src/layouts/DashboardLayout.tsx`
- All page components that render `<Link>`

---

## Phase 2: Header and Navigation

### 2.1 Header Project Display

Display the active project name (from `useProject()` context, not from `/health` config). If multiple projects exist, the project name could be a link/dropdown to switch projects.

**Files:** `dashboard/src/components/HealthBar.tsx`

---

## Phase 3: Message and Chat UX

### 3.1 Message Card Styling

Replace flat message rendering with Mantine `Paper` or `Card` components:
- Sender name prominent at top
- Timestamp alongside sender
- Visual colour differentiation per sender (hash agent name to Mantine colour)
- Spacing between cards

**Files:** Message-related components in `dashboard/src/`

### 3.2 Markdown Rendering

Add a markdown renderer for message payloads:
- `react-markdown` + syntax highlighter for code blocks
- Fallback to raw text on parse failure
- Apply to both Messages page and Chat page

**Files:** Message and Chat page components

### 3.3 Scroll Behaviour Fix

For chat and message views:
- Track `isAtBottom` state via scroll position
- Only auto-scroll when user is at bottom
- Show "Jump to latest" button when scrolled up and new messages arrive

**Files:** Chat and Messages page components

---

## Phase 4: URL-Driven State Management

### 4.1 Consolidate Filter State into URL Search Params

- Messages: `/$projectId/messages/$channel?type=X&agent=Y`
- Overview: `/$projectId/?status=X&agent=Y&sort=Z&page=N`
- Builds: `/$projectId/logs?agent=X&type=Y`
- All filters persist on refresh and are shareable

(Partially done already via `validateSearch` on several routes.)

**Files:** All page components with filter state

---

## Critical Files Summary

| File | Change |
|------|--------|
| `dashboard/src/router.tsx` | Route tree restructuring with `$projectId` layout |
| `dashboard/src/layouts/DashboardLayout.tsx` | Project-aware layout + nav links |
| `dashboard/src/api/client.ts` | `x-project-id` header on all requests |
| `dashboard/src/api/types.ts` | `Project` type |
| `dashboard/src/components/HealthBar.tsx` | Project name from context |
| New: `dashboard/src/contexts/ProjectContext.tsx` | `useProject()` hook and provider |
| All page components and hooks | `projectId` from context, updated `<Link>` targets |
| Message/Chat components | Card styling, markdown rendering, scroll behaviour |
