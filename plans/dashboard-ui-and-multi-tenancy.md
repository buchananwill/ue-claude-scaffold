# Plan: Dashboard UI Upgrades + Multi-Tenancy (Updated for Drizzle)

## Context

The original plan (`plans/audit-dashboard-ui-upgrades.md`) was written before the Drizzle/PGlite migration. Two things have changed since:

1. **Database is now Postgres (PGlite) with Drizzle ORM** - 9 of 14 tables have a `project_id` column (defaulting to `'default'`). A `project-id` Fastify plugin reads `x-project-id` from request headers. The config system supports multi-project via `resolvedProjects` in `scaffold.config.json`.
2. **Dashboard has no project awareness** - no `x-project-id` header sent, no project selector, no route parameterization.

Additionally, the original plan references "Tailwind classes" and "shadcn/ui" but the dashboard uses **Mantine UI**.

### Design Issue: Split Authority

Project configuration currently lives in `scaffold.config.json` (`resolvedProjects`), while all other server state lives in the database. This creates split authority: the JSON file is the source of truth for project identity/config, but the DB is the source of truth for everything scoped to a project. This should be unified with the **database as the single authority** for project definitions.

---

## Epoch 1: Structural Multi-Tenancy (DB as Authority)

**Goal:** Move project configuration from JSON into the database. Make the DB the single source of truth for project identity and configuration. Retire `resolvedProjects` from `scaffold.config.json`.

### 1.1 New `projects` Table

Add a Drizzle table for project configuration:

```
projects
  id           text PK        (validated: [a-zA-Z0-9_-]{1,64})
  name         text NOT NULL
  path         text NOT NULL   (host project path)
  uproject_file text
  bare_repo_path text NOT NULL
  tasks_path   text
  plan_branch  text
  engine_path  text
  engine_version text
  build_script_path text
  test_script_path text
  build_timeout_ms integer
  test_timeout_ms integer
  staging_worktree_root text
  staging_copies jsonb         (array of {source, relativeDest})
  created_at   timestamp DEFAULT now()
```

This mirrors the existing `ProjectConfig` interface (`server/src/config.ts:4-15`).

### 1.2 Seed from JSON Config

On server startup, seed the `projects` table from `resolvedProjects` in the JSON config using INSERT-only semantics:

- If a project ID from JSON does **not** exist in the DB: insert it.
- If a project ID from JSON **already** exists in the DB: validate that the JSON config matches the DB record. Log an error if they diverge (but don't overwrite). Skip the insert.

This makes JSON + boot a convenience path for initializing a new DB without manual API calls. Changes to existing projects must go through the API endpoints explicitly.

### 1.3 Project CRUD Endpoints

```
GET    /projects              - list all projects
GET    /projects/:id          - get single project config
POST   /projects              - create a new project
PATCH  /projects/:id          - update project config
DELETE /projects/:id          - reject with 409 if any data exists for this project
```

### 1.4 Refactor `getProject()` and Route Handlers

- `getProject(config, id)` (`server/src/config.ts:251`) currently reads from `config.resolvedProjects`. This becomes a DB query.
- Routes that use `request.projectId` (from the `project-id` plugin) should validate the project exists in the DB, not in config.
- The `project-id` plugin (`server/src/plugins/project-id.ts`) should validate against DB and attach the full project record to the request (not just the string ID).

### 1.5 Simplify `scaffold.config.json`

After this change, the JSON config retains only server-level concerns:
- `server.port`
- `server.ubtLockTimeoutMs`
- PGlite data directory (if applicable)
- Any other host-level settings not scoped to a project

Project-specific fields (`project.*`, `engine.*`, `build.*`, `tasks.*`, `plugins.*`) move to the DB. The legacy format is still accepted for initial seeding but is not the runtime authority.

### 1.6 Health Endpoint Update

`GET /health` (`server/src/routes/health.ts`) currently returns `config.projectName` from the JSON. This should either:
- Drop project info from health (it's a server-level endpoint), or
- Accept `x-project-id` and return that project's name from the DB

### Design Decisions (Epoch 1)

- **Delete semantics:** `DELETE /projects/:id` returns 409 Conflict if any agents, tasks, messages, builds, or other data exist for that project. User must clean up associated data first.
- **JSON seed behavior:** INSERT-only, not upsert. Validate-and-warn on conflict. JSON is a convenience for DB initialization, not the runtime authority.
- **Config scope:** Full `ProjectConfig` in the DB (all build/engine/plugin fields). DB is the single authority for everything project-specific.
- **Hot reload:** DB-backed config naturally supports hot changes without server restart, which is an advantage over JSON.

---

## Epoch 2: Dashboard UI Upgrades

**Goal:** Make the dashboard project-aware (routing, data fetching, header display) and implement the UI improvements from the original plan.

**Depends on:** Epoch 1 (needs `GET /projects` endpoint and DB-backed project identity).

### 2.1 Project-Scoped Routing

**File:** `dashboard/src/router.tsx`

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

Root route behavior: fetch `GET /projects`. If single project, auto-redirect to `/$id/`. If multiple, render a project picker.

### 2.2 ProjectProvider Context

A React context at the `$projectId` layout level that:
- Reads `$projectId` from route params
- Fetches project details from `GET /projects/:id`
- Provides `{ projectId, projectName }` to all children via `useProject()` hook

### 2.3 API Client: `x-project-id` Header

**File:** `dashboard/src/api/client.ts`

All `apiFetch`/`apiPost`/`apiPatch`/`apiDelete` calls include `x-project-id` from context. Either:
- Accept `projectId` as a parameter, or
- Read from a module-level store set by the provider

### 2.4 Header Display

**File:** `dashboard/src/components/HealthBar.tsx`

Display the active project name (from `useProject()` context, not from `/health` config). If multiple projects exist, the project name could be a link/dropdown to switch projects.

### 2.5 Nav Link Updates

All `<Link>` components in `DashboardLayout` and page components must include the `projectId` param so URLs stay project-scoped.

### 2.6 Message Card Styling

Replace flat message rendering with Mantine `Paper` or `Card` components:
- Sender name prominent at top
- Timestamp alongside sender
- Visual color differentiation per sender (hash agent name to Mantine color)
- Spacing between cards

**Note:** Original plan referenced Tailwind/shadcn; use Mantine equivalents.

### 2.7 Markdown Rendering

Add a markdown renderer for message payloads:
- `react-markdown` + syntax highlighter for code blocks
- Fallback to raw text on parse failure
- Apply to both Messages page and Chat page

### 2.8 Scroll Behavior Fix

For chat and message views:
- Track `isAtBottom` state via scroll position
- Only auto-scroll when user is at bottom
- Show "Jump to latest" button when scrolled up and new messages arrive

### 2.9 URL-Driven State Management

Consolidate remaining client-side filter state into URL search params:
- Messages: `/$projectId/messages/$channel?type=X&agent=Y`
- Overview: `/$projectId/?status=X&agent=Y&sort=Z&page=N`
- Builds: `/$projectId/logs?agent=X&type=Y`
- All filters persist on refresh and are shareable

(Partially done already via `validateSearch` on several routes.)

---

## What the Original Plan Got Wrong

| Original Claim | Reality |
|---|---|
| "No server schema changes needed" | Need `projects` table + CRUD endpoints |
| "No new database tables" | `projects` table is new |
| Tailwind classes for styling | Dashboard uses Mantine UI |
| shadcn/ui Card component | Use Mantine `Paper`/`Card` |
| "Independent of server migration" | Epoch 2 depends on Epoch 1's `GET /projects` |
| `/chat/:roomId` route shape | Becomes `/$projectId/chat?room=X` |

---

## Critical Files

### Epoch 1 (Server)
- `server/src/schema/tables.ts` - new `projects` table
- `server/src/config.ts` - simplify; `getProject()` becomes DB query
- `server/src/plugins/project-id.ts` - validate against DB, attach project record
- `server/src/routes/health.ts` - decouple from JSON project config
- New: `server/src/routes/projects.ts` - CRUD endpoints
- New: `server/src/queries/projects.ts` - DB query functions

### Epoch 2 (Dashboard)
- `dashboard/src/router.tsx` - route tree restructuring
- `dashboard/src/layouts/DashboardLayout.tsx` - project-aware layout + nav
- `dashboard/src/api/client.ts` - `x-project-id` header
- `dashboard/src/api/types.ts` - `Project` type
- `dashboard/src/components/HealthBar.tsx` - project name from context
- All page components and hooks - `projectId` from context
