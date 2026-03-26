# Dashboard Links & UX Fixes

Structured from [issues/033-buttons-should-be-links.md](../issues/033-buttons-should-be-links.md).

## Problem Summary

The dashboard has accumulated several UX paper cuts across the Overview, Messages, and navigation layers. The common thread: state that should be URL-driven is trapped in ephemeral React state, and elements that should be native links are `onClick` buttons — breaking right-click, middle-click, and browser history.

---

## Plan

### 1. Convert nav buttons to `<Link>` components

**File:** `dashboard/src/layouts/DashboardLayout.tsx` (lines 35-74)

All five top-level nav items (`Overview`, `Messages`, `Logs`, `Chat`, `Teams`) use `<NavLink onClick={() => router.navigate(...)}>`. Replace each with TanStack Router `<Link>` wrapped in Mantine's `<NavLink component={Link} to="...">`. This gives native `<a>` semantics: right-click → "Open in new tab", middle-click, Ctrl+click, link preview in status bar.

Same treatment for any other `onClick={navigate}` patterns found in `TeamCard.tsx` or similar.

### 2. Move task filters to URL search params

**Files:** `dashboard/src/hooks/useTaskFilters.ts`, `dashboard/src/components/TasksPanel.tsx`, `dashboard/src/router.tsx`

Currently `statusFilter`, `agentFilter`, `priorityFilter` are `useReducer`/`useState` in `useTaskFilters.ts`. They reset on every route transition.

- Add search param definitions to the `/` route in `router.tsx`: `status`, `agent`, `priority` (comma-separated strings).
- Rewrite `useTaskFilters` to read from and write to search params via TanStack Router's `useSearch` / `useNavigate({ search })`.
- Filter chip clicks call `navigate({ search: { status: newValue } })` instead of `dispatch`.
- This makes filter sets bookmarkable and stable across `Overview → Chat → Overview`.

### 3. Move task sorting to URL search params

**Files:** same as step 2

The sort reducer (3-state cycle: `null → asc → desc → null`) currently uses local state for `sortColumn` and `sortDirection`.

- Add `sort` and `dir` search params to the `/` route.
- Column header clicks update search params.
- Default: no search params = default ordering (by id).

### 4. Show task working duration

**Files:** `dashboard/src/components/TasksPanel.tsx`, `dashboard/src/pages/TaskDetailPage.tsx`

`claimedAt` and `completedAt` already exist in the task data model (`api/types.ts:32-33`). The UI shows raw timestamps but never computes duration.

- In the task table: add a "Duration" column that shows `completedAt - claimedAt` for finished tasks, or `now - claimedAt` (live-updating) for claimed/in-progress tasks. Use a concise format like `2h 14m`.
- In `TaskDetailPage`: add a duration line below the existing Claimed/Completed timestamps.
- For unclaimed tasks, show `—`.

### 5. Audit `in_progress` and `failed` status usage on the server

**Files:** `server/src/routes/tasks.ts` (and related)

The UI renders all five statuses (`pending`, `claimed`, `in_progress`, `completed`, `failed`) with chips, badges, and colors. But the issue reports that `in_progress` and `failed` may never actually be set by any agent or server endpoint.

- Grep the server for where task status transitions happen.
- If `in_progress` and `failed` are dead code: either wire them into the task lifecycle properly (e.g., `claimed → in_progress` when work begins, `→ failed` on error), or remove them from the UI to avoid confusion.
- Recommendation: wire them in. `in_progress` is useful to distinguish "agent claimed but hasn't started" from "agent is actively working." `failed` is essential for error visibility.

### 6. Add agent filter to Messages page

**Files:** `dashboard/src/pages/MessagesPage.tsx`, `dashboard/src/components/MessagesFeed.tsx`

Messages already filter by channel (path param) and type (search param). There is no filter by `fromAgent`.

- Add an `agent` search param to the `/messages/$channel` route.
- Add a filter control (chip group or select) populated from the agents list.
- Filter the message feed by `fromAgent` when set.

### 7. Audit `build_start`, `build_end`, `test_start`, `test_end` message types

**Files:** `server/src/routes/messages.ts`, `container/hooks/intercept_build_test.sh`

These types are defined in the UI's `KNOWN_TYPES` array (`MessagesFeed.tsx:30-33`) but the issue reports no agent has ever sent them. Investigate:

- Does the build intercept hook post `build_start`/`build_end` messages, or just return results?
- If the protocol never emits them: add message posting to the build/test intercept flow (start before calling `/build`, end after result), or remove these types from the UI.

### 8. Improve text search UX

**Files:** `dashboard/src/components/SearchBar.tsx`

Two problems:

**a) "Show all matching" mode.** Currently search results appear in a popover and each result navigates to a specific item. Add a "Show all N results" link at the bottom of the popover that navigates to a `/search?q=term` results page (or expands the popover into a full list). This lets users scan all matches without clicking through one by one.

**b) Blur behavior.** Currently `onBlur` behavior is unclear. The desired behavior: `onBlur` closes the results popover but preserves the search input value. Re-focusing the input should re-open the popover with the existing query (no re-fetch needed if within debounce window). This lets users click away mid-search and resume without retyping.

---

## Execution Order

Steps 1-4 are independent and can be parallelized. Step 5 requires a server-side investigation. Steps 6-8 are independent of each other but lower priority.

Priority grouping:
- **P0 (core UX):** Steps 1, 2, 3 — fixes "state lost on navigation" and "can't right-click" problems.
- **P1 (visibility):** Steps 4, 5, 6 — adds missing information and filtering.
- **P2 (polish):** Steps 7, 8 — audit dead features and improve search.
