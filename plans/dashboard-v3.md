---
title: Dashboard V3 — From Status Board to Investigation Tool
priority: 1
---

# Dashboard V3 — From Status Board to Investigation Tool

## Context

V1 proved the UX: tabs, polling, expandable rows, filter chips. V2 replaced the prototype internals with TanStack Router (type-safe routes, URL state) and TanStack Query (dedup, stale-while-revalidate, cache invalidation). The component decomposition, Mantine dark theme, and Vite proxy strategy carried through unchanged.

V3 makes the dashboard useful at scale. When there are 50+ tasks across multiple agents, hundreds of messages interleaving across channels, and a build history accumulating over hours of autonomous work, scrolling and eyeballing doesn't cut it. The dashboard needs to become the place you go to **find things** and **understand what happened** — not just see what's happening right now.

### What V2 established (the foundation V3 builds on)

- **TanStack Router** with routes `/`, `/messages`, `/messages/$channel`. Route tree is code-defined (not file-based). Type-safe params. Future route shapes are stubbed but unimplemented.
- **TanStack Query** for all data fetching. Hooks: `useHealth`, `useAgents`, `useTasks`, `useUbtStatus`. Each uses `refetchInterval` from a shared `PollIntervalContext`. `useTasks` uses `placeholderData: keepPreviousData` for flash-free filter transitions. `useMessages` is custom (cursor-based append, capped at 1000 messages).
- **Consistent camelCase** across all API responses. Server-side `formatAgent()` and `formatMessage()` normalise the DB's snake_case. Dashboard types in `api/types.ts` match.
- **Proper error extraction** in `api/client.ts` — parses Fastify JSON error bodies for human-readable messages.
- **`queryClient.invalidateQueries`** for post-mutation refresh in TasksPanel and AgentsPanel.

### What the server already supports that the dashboard doesn't surface

- **`build_history` table**: Records every build/test invocation with agent, type, started_at, duration_ms, success. Written by `POST /build` and `POST /test` via `recordBuildStart`/`recordBuildEnd` in `ubt.ts`. **No GET endpoint exists yet** — needs a new route.
- **Message type filtering**: `GET /messages/:channel?type=<type>` already works server-side. Dashboard only uses the `?since=` param.
- **Task `sourcePath` and `acceptanceCriteria`**: Present in the data model, surfaced in the expanded row, but not searchable or filterable.
- **Task `progressLog`**: Timestamped newline-delimited entries. Displayed as a raw code block. Not searchable.
- **Cross-entity links**: `tasks.claimedBy`, `messages.fromAgent`, `build_history.agent` all reference agent names by convention (not FK). Could be joined in the dashboard to show "everything this agent did."

### Implicit constraints

- **No WebSocket**: The coordination server is Fastify + SQLite with polling. TanStack Query's `refetchInterval` is the real-time strategy. This is fine for a local dev tool dashboard and avoids adding WS infrastructure.
- **SQLite full-text search**: SQLite has FTS5 but the current schema doesn't use it. Global search in Phase 1 will use `LIKE` queries, which is perfectly adequate for the data volumes this tool sees (hundreds to low thousands of rows). If that becomes a bottleneck, FTS5 can be added as a schema migration later.
- **Build output is not stored**: `POST /build` and `POST /test` return stdout/stderr to the caller (the container agent) but don't persist the output in `build_history`. Phase 4 adds columns for this. This is the biggest schema change in V3.
- **Vite SPA, not Next.js**: The dashboard is a plain React SPA built with Vite. No SSR, no server components. All framework advice about Next.js App Router, `"use client"`, etc. does not apply.
- **Node built-in test runner**: Server tests use `node:test` + `node:assert` via tsx. No Jest, no Vitest.

---

## Phase 1 — Global Search

The highest-leverage feature. A single text input that searches across tasks, messages, and agents simultaneously.

### Server: `GET /search?q=<term>`

**File: `server/src/routes/search.ts`** (new)

New Fastify plugin with a single endpoint:

```
GET /search?q=<term>&limit=<n>
```

- `q` is required, minimum 2 characters. Return 400 if missing or too short.
- `limit` defaults to 20 per entity type.
- Searches:
  - **Tasks**: `title LIKE '%term%' OR description LIKE '%term%' OR progress_log LIKE '%term%' OR acceptance_criteria LIKE '%term%'`
  - **Messages**: `payload LIKE '%term%' OR from_agent LIKE '%term%'`
  - **Agents**: `name LIKE '%term%' OR worktree LIKE '%term%'`
- Returns:

```json
{
  "tasks": [ ...formatted tasks... ],
  "messages": [ ...formatted messages... ],
  "agents": [ ...formatted agents... ]
}
```

- Use the existing `formatTask()` (from tasks.ts), `formatAgent()` (from agents.ts), and the message formatting inline function (from messages.ts). **Refactor**: extract `formatMessage()` as a named export from messages.ts (V2 inlined it in the route handler).
- Case-insensitive: SQLite's `LIKE` is case-insensitive for ASCII by default, which covers agent names, task titles, etc.

**File: `server/src/routes/search.test.ts`** (new)

- Search finds task by title
- Search finds task by description substring
- Search finds message by payload content
- Search finds agent by name
- Empty query returns 400
- Single-char query returns 400
- Results respect limit param
- No cross-contamination: searching for a task title doesn't return unrelated messages

### Dashboard: search bar + results overlay

**File: `dashboard/src/hooks/useSearch.ts`** (new)

- `useQuery` with `queryKey: ['search', debouncedTerm]`
- `enabled: debouncedTerm.length >= 2` — don't fire on empty or single-char input
- Debounce: 300ms. Use a simple `useEffect` + `setTimeout` debounce on the input value. Don't add a library for this.
- `staleTime: 10000` — search results don't need constant polling
- No `refetchInterval` — search is on-demand, not polled

**File: `dashboard/src/components/SearchBar.tsx`** (new)

- Text input in the AppShell header (right side, next to the poll interval control)
- Keyboard shortcut: `/` focuses the search bar (standard dashboard convention)
- Results appear in a dropdown/overlay below the input:
  - Grouped by type: "Tasks", "Messages", "Agents" with counts
  - Each result shows: entity type icon, primary text (task title / message payload snippet / agent name), secondary text (status, channel, etc.)
  - Clicking a task result navigates to `/` with the task highlighted (or future `/tasks/$taskId`)
  - Clicking a message result navigates to `/messages/$channel`
  - Clicking an agent result navigates to future `/agents/$agentName` (stub: navigate to `/` for now)
- Escape closes the overlay
- Show "No results" state, loading spinner during search

**File: `dashboard/src/layouts/DashboardLayout.tsx`** (modify)

- Add `SearchBar` component to the header, between the project name and poll interval control

**File: `dashboard/src/api/types.ts`** (modify)

- Add `SearchResults` interface:

```typescript
interface SearchResults {
  tasks: Task[];
  messages: Message[];
  agents: Agent[];
}
```

### Acceptance criteria

- [ ] Type "shader" → tasks mentioning "shader" appear grouped under Tasks
- [ ] Type an agent name → agent card appears, plus all their messages and tasks
- [ ] Results link to the correct page/entity
- [ ] Debounce prevents request flood while typing
- [ ] Empty/short input shows no results, no error
- [ ] `cd server && npm test` passes (new search tests)
- [ ] `cd dashboard && npx tsc -b && npx vite build` passes

---

## Phase 2 — Columnar Filtering & Sorting on TasksPanel

This is the "find the thread" feature. When 5 agents have interleaved 40 tasks, you need to slice by agent, sort by recency, and see the pattern.

### All client-side — no server changes

The `GET /tasks` endpoint already returns all tasks (optionally filtered by status). Columnar sorting and filtering operates on the already-fetched array. This is fine for the data volumes this tool sees.

**File: `dashboard/src/components/TasksPanel.tsx`** (modify)

#### Sortable columns

- Clickable column headers for: `#` (id), `Pri` (priority), `Status`, `Title`, `Agent` (claimedBy), `Created` (createdAt)
- Click toggles: ascending → descending → no sort (reset to default: priority desc, id asc)
- Visual indicator: small arrow icon in header (▲/▼/none)
- State: `sortColumn: string | null`, `sortDir: 'asc' | 'desc'`
- Sort function: generic comparator that handles string, number, date, null (nulls sort last)

#### Per-column filter popovers

Only on columns where filtering adds value:

- **Agent** (claimedBy): Popover with a list of checkboxes for each unique agent name in the current data + "Unassigned". Multi-select.
- **Status**: Already handled by the SegmentedControl at the top. Keep that — don't duplicate.
- **Priority**: Popover with a numeric range or checkboxes for distinct priority values present.

The filter state should compose with the existing status filter. When both are active, it's an AND: status=claimed AND agent∈{agent-1, agent-3}.

#### Active filter indicator

- Show a small badge count on column headers that have active filters
- "Clear all filters" link appears when any column filter is active

#### Task deletion

The server already supports `DELETE /tasks/:id` (rejects claimed/in_progress with 409, returns descriptive error) and `DELETE /tasks?status=<status>` for bulk delete. The dashboard just needs to expose them.

**Single task delete:**

- Add a trash icon button in the Actions column, next to the existing Release button
- Only show on tasks that are **not** claimed or in_progress (the server will reject those anyway, but don't offer the button)
- Confirmation popover (same pattern as AgentsPanel's delete confirmation): "Delete task #N?" → Yes / No
- On success: `queryClient.invalidateQueries({ queryKey: ['tasks'] })` + success notification
- On error: show server's error message in a red notification (the `extractError` in `client.ts` will surface the "cannot delete a task that is claimed or in progress" message if the status changed between render and click)

**Bulk delete:**

- Add a "Delete completed" button (or "Delete failed") above the task table, next to the filter controls
- Only visible when the status filter is set to `completed` or `failed` — these are the cleanup-appropriate statuses
- Calls `apiDelete('/tasks?status=completed')` (or `failed`)
- Confirmation: "Delete all N completed tasks?" with count from current data
- On success: invalidate + notification showing deleted count

**File: `dashboard/src/hooks/useTaskFilters.ts`** (new)

- Encapsulates sort + column filter state
- Input: `Task[]` array from `useTasks`
- Output: sorted + filtered `Task[]`, plus state setters
- Pure client-side transform — no query key changes, no server round-trips

### Acceptance criteria

- [ ] Click "Created" header → tasks sort by newest first; click again → oldest first; click again → default
- [ ] Click "Agent" header → popover with agent checkboxes; select "agent-1" → only agent-1's tasks shown
- [ ] Agent filter + status filter compose: status=in_progress AND agent=agent-1 shows intersection
- [ ] Clear filters resets all column filters and sort
- [ ] No loading flash when sorting/filtering (it's client-side on existing data)
- [ ] Trash icon on a pending task → confirm → task deleted, list refreshes
- [ ] Trash icon does not appear on claimed/in_progress tasks
- [ ] "Delete completed" button visible when filter is set to completed → confirm → all deleted, count shown
- [ ] If a task's status changes between render and delete click, server error message surfaces correctly
- [ ] `cd dashboard && npx tsc -b && npx vite build` passes

---

## Phase 3 — Agent Detail Page

The cross-entity view. Currently to understand "what is agent-1 doing?" you check three panels. This page joins them.

### Route

**File: `dashboard/src/router.tsx`** (modify)

- Add route: `/agents/$agentName` → `AgentDetailPage`

**File: `dashboard/src/pages/AgentDetailPage.tsx`** (new)

Layout: single-column stack with sections.

#### Header section

- Agent name (large), status badge, registered time
- Worktree/branch name
- Plan doc path (if set)
- "Back to Overview" link

#### Tasks section

- Reuse `TasksPanel` component, but pre-filtered to `claimedBy === agentName`
- This means the existing status filter and new column filters (Phase 2) work here too
- Section title: "Tasks (N)" with count

#### Messages section

- Reuse `MessagesFeed` component with channel set to the agent's name
- Messages from this agent across all channels would be ideal, but the current API only supports per-channel queries. Two options:
  - **Option A (simple)**: Show the agent's own channel (most messages from a container agent go to their named channel)
  - **Option B (new endpoint)**: `GET /messages?from=<agentName>` — cross-channel query by sender. This requires a new server endpoint.
- **Recommendation**: Start with Option A. Add Option B in Phase 5 (server API gaps, below) if it proves necessary.

#### Build history section

- Depends on Phase 4 (build log viewer). If Phase 4 is done, show this agent's builds here.
- If Phase 4 is not done yet, omit this section — it can be added later since the route and page structure are in place.

### Navigation integration

**File: `dashboard/src/components/AgentsPanel.tsx`** (modify)

- Agent name in the table becomes a clickable link to `/agents/$agentName`

**File: `dashboard/src/components/TasksPanel.tsx`** (modify)

- Agent name in the "Agent" column becomes a clickable link to `/agents/$agentName`

**File: `dashboard/src/layouts/DashboardLayout.tsx`** (modify)

- No nav bar change needed — agent detail is accessed by clicking an agent name, not via top-level nav

### Acceptance criteria

- [ ] Click agent name in AgentsPanel → navigates to `/agents/agent-1`
- [ ] Agent detail page shows agent status, tasks claimed by this agent, messages in this agent's channel
- [ ] TasksPanel filters work on the agent detail page
- [ ] Browser back returns to previous page
- [ ] Direct link `/agents/agent-1` loads correctly (deep link)
- [ ] `cd dashboard && npx tsc -b && npx vite build` passes

---

## Phase 4 — Build Log Viewer

The `build_history` table is being written to on every build/test invocation but has no GET endpoint and no dashboard surface.

### Server: `GET /builds`

**File: `server/src/routes/builds.ts`** (new)

New Fastify plugin:

```
GET /builds?agent=<name>&type=<build|test>&limit=<n>&since=<id>
```

- All params optional. Default limit: 50.
- Returns array of formatted build history entries (camelCase):

```json
[{
  "id": 1,
  "agent": "agent-1",
  "type": "build",
  "startedAt": "2025-01-15T10:30:00",
  "durationMs": 45000,
  "success": true,
  "output": "...",
  "stderr": "..."
}]
```

- Order: `id DESC` (most recent first)

**Important**: The current `build_history` table does **not** store `output` or `stderr` — those are returned by `POST /build` and `POST /test` directly to the caller but discarded. To make the build log viewer useful, we need to store them.

### Schema change: add output columns to build_history

**File: `server/src/db.ts`** (modify)

- Bump schema version to 4
- Add migration: `ALTER TABLE build_history ADD COLUMN output TEXT` and `ALTER TABLE build_history ADD COLUMN stderr TEXT`
- Since this is SQLite and the tool is early-stage, an `ALTER TABLE ADD COLUMN` is safe and backward-compatible (existing rows get NULL for the new columns)

**File: `server/src/routes/build.ts`** (modify)

- Update `recordBuildEnd` calls to also store `output` and `stderr` from the SpawnResult
- This requires changing `recordBuildEnd` signature in `ubt.ts`

**File: `server/src/routes/ubt.ts`** (modify)

- `recordBuildEnd(id, durationMs, success, output, stderr)` — extend the UPDATE statement to include the new columns

**File: `server/src/routes/builds.test.ts`** (new)

- GET /builds returns empty array initially
- After build, GET /builds returns the record with correct fields
- Filter by agent, filter by type
- Limit and since params work
- Output and stderr are returned when present

### Dashboard

**File: `dashboard/src/router.tsx`** (modify)

- Add route: `/logs` → `BuildLogPage`

**File: `dashboard/src/layouts/DashboardLayout.tsx`** (modify)

- Add "Logs" nav link

**File: `dashboard/src/pages/BuildLogPage.tsx`** (new)

Layout:

- Filter bar: agent dropdown (all agents), type toggle (All / Build / Test), success toggle (All / Pass / Fail)
- Table: Agent, Type, Started, Duration, Success, expandable row with output/stderr
- Duration formatted as human-readable (e.g., "45s", "2m 12s")
- Success as green checkmark / red X
- Expandable row: two code blocks — stdout and stderr, with stderr highlighted if non-empty
- Auto-polls with shared `intervalMs` like other hooks

**File: `dashboard/src/hooks/useBuildHistory.ts`** (new)

- `useQuery` with `queryKey: ['builds', agentFilter, typeFilter]`
- `refetchInterval` from poll interval context
- `placeholderData: keepPreviousData` for flash-free filter transitions

**File: `dashboard/src/api/types.ts`** (modify)

- Add `BuildRecord` interface

### Acceptance criteria

- [ ] `/logs` shows build/test history ordered by most recent
- [ ] Filter by agent → only that agent's builds
- [ ] Filter by type → only builds or only tests
- [ ] Expand a row → stdout and stderr visible
- [ ] Builds that happened before the schema migration show null output/stderr (no crash)
- [ ] `cd server && npm test` passes (new build history tests + existing tests unbroken)
- [ ] `cd dashboard && npx tsc -b && npx vite build` passes

---

## Phase 5 — Message Type Filtering

The server already supports `?type=` filtering. This phase exposes it in the dashboard.

### No server changes needed

**File: `dashboard/src/components/MessagesFeed.tsx`** (modify)

- Add a multi-select chip bar above the messages list
- Chips for known message types: info, progress, build_start, build_end, test_start, test_end, error, warning
- Also: "All" chip that clears the filter
- Dynamically add chips for any types seen in the current messages that aren't in the hardcoded list

**File: `dashboard/src/hooks/useMessages.ts`** (modify)

- Accept optional `typeFilter?: string` parameter
- Append `&type=${typeFilter}` to the fetch URL when set
- When type filter changes, reset the cursor and message buffer (same as channel change)

**File: `dashboard/src/pages/MessagesPage.tsx`** (modify)

- Add type filter state, pass to `useMessages` and `MessagesFeed`

### Acceptance criteria

- [ ] Click "error" chip → only error-type messages shown
- [ ] Click "All" → filter cleared, all messages shown
- [ ] Changing type filter resets the message buffer (no stale messages from previous filter)
- [ ] Type filter + channel selection compose correctly
- [ ] Unknown message types that appear in the data get dynamically-added chips
- [ ] `cd dashboard && npx tsc -b && npx vite build` passes

---

## Phase 6 — Message Feed Improvements

Two usability gaps in the message feed that become obvious once search links you into specific channels.

### 6A: Pagination / Virtual Scrolling

The current `useMessages` hook appends every message since the cursor, unbounded (capped at 1000 client-side). The server's `GET /messages/:channel` has no `LIMIT` — it returns all matching rows. On a long-running session with hundreds of messages per channel, this causes:
- Large payloads on initial page load (all messages dumped at once)
- DOM bloat (every message rendered in the ScrollArea)
- The 1000-message client-side cap silently drops older messages with no way to scroll back to them

#### Server: add `limit` and `before` params to `GET /messages/:channel`

**File: `server/src/routes/messages.ts`** (modify)

- Add optional `limit` and `before` query params:
  ```
  GET /messages/:channel?since=<id>&before=<id>&type=<type>&limit=<n>
  ```
- `limit` defaults to 100. Caps maximum per-request payload.
- `before` enables backward pagination: `WHERE id < ? ORDER BY id DESC LIMIT ? → reverse the result`. Combined with the existing `since` param, this gives bidirectional cursor pagination.
- When neither `since` nor `before` is set, return the most recent `limit` messages (not all messages from the beginning of time).

#### Dashboard: paginated feed with "load older" affordance

**File: `dashboard/src/hooks/useMessages.ts`** (modify)

- On initial load, fetch the most recent `limit` messages (no `since` param — server returns newest)
- Continue polling with `since=<lastId>` for new messages (existing behavior)
- Add a `loadOlder()` callback that fetches `?before=<oldestId>&limit=100` and prepends to the buffer
- Track `hasOlder: boolean` (false when a `loadOlder` response returns fewer than `limit` messages)
- Remove the hard 1000-message cap — pagination makes it unnecessary. If memory is a concern, consider virtualizing the DOM (see below) rather than dropping data.

**File: `dashboard/src/components/MessagesFeed.tsx`** (modify)

- Add "Load older messages" button at the top of the ScrollArea, visible when `hasOlder` is true
- Consider using Mantine's `ScrollArea` with a virtualizer (e.g., `@tanstack/react-virtual`) for large message lists — only render visible rows. This is optional for Phase 6A but recommended.
- Preserve scroll position when prepending older messages (the viewport should not jump)

### 6B: Search-to-Message Highlight

When the user clicks a message search result, they should land on the right channel AND see the specific message highlighted, not just dumped at the bottom of a feed.

#### Server: add `GET /messages/:id` endpoint

**File: `server/src/routes/messages.ts`** (modify)

- Add `GET /messages/by-id/:id` — returns a single formatted message. This gives the dashboard the message's channel and position without needing to scan the feed.
- Alternative: the search results already include the channel and ID, so this may not be strictly necessary if the dashboard can use `?before=` and `?since=` to load a window around the target message.

#### Dashboard: scroll-to and highlight

**File: `dashboard/src/components/SearchBar.tsx`** (modify)

- Message click: navigate to `/messages/$channel` with search param `?highlight=<messageId>`

**File: `dashboard/src/pages/MessagesPage.tsx`** (modify)

- Read `highlight` search param from URL
- Pass `highlightMessageId` to `useMessages` and `MessagesFeed`

**File: `dashboard/src/hooks/useMessages.ts`** (modify)

- When `highlightMessageId` is provided, ensure the message is in the buffer:
  - If the message ID is within the initially-loaded range, it's already there
  - If not, load a page centered around that ID using `before`/`since` params
- Expose the highlight ID to the component

**File: `dashboard/src/components/MessagesFeed.tsx`** (modify)

- When `highlightMessageId` is set:
  - Scroll to that message row (via ref + `scrollIntoView`)
  - Apply a flash highlight (background color transition, auto-clears after 2-3s)
  - Clear the URL search param after highlighting (so refresh doesn't re-flash)

### Acceptance criteria

- [ ] Initial message load fetches only the most recent 100, not the entire history
- [ ] "Load older" button appears at the top → clicking loads the previous 100
- [ ] Scroll position preserved when loading older messages
- [ ] Poll continues appending new messages at the bottom
- [ ] Search → click message result → navigates to channel, scrolls to message, flash-highlights it
- [ ] Highlight auto-clears after 2-3 seconds
- [ ] Refreshing the page does not re-trigger the highlight
- [ ] `cd server && npm test` passes
- [ ] `cd dashboard && npx tsc -b && npx vite build` passes

---

## Phase ordering and dependencies

```
Phase 1 (Search)           — independent, can start immediately
Phase 2 (Column Filters)   — independent, can start immediately
Phase 3 (Agent Detail)     — depends on Phase 2 (reuses filtered TasksPanel)
Phase 4 (Build Logs)       — independent, can start immediately (server schema change)
Phase 5 (Message Filters)  — independent, can start immediately
Phase 6 (Message Feed)     — depends on Phase 1 (search links to messages) and Phase 5 (type filter)
```

Phases 1, 2, 4, 5 are parallelizable. Phase 3 should follow Phase 2 so the agent detail page gets column filtering for free.

Recommended execution order for a single implementer: **2 → 1 → 5 → 3 → 4 → 6**

- Phase 2 first because it's pure client-side, low risk, and Phase 3 depends on it
- Phase 1 next because search is the highest user-value feature
- Phase 5 is small and self-contained
- Phase 3 composes existing pieces
- Phase 4 next because it has the broadest surface area (schema migration, new server route, new dashboard page)
- Phase 6 last because it depends on Phase 1 (search) and Phase 5 (type filter) being in place

## Verification (full V3)

1. `cd server && npm test` — all tests pass including new search and build history tests
2. `cd dashboard && npx tsc -b && npx vite build` — clean
3. Search for a task keyword → results appear, clicking navigates correctly
4. Sort tasks by created date → order changes; filter by agent → subset shown; compose with status filter → intersection
5. Click agent name → agent detail page with tasks, messages for that agent
6. Navigate to `/logs` → build history with expandable output/stderr
7. Filter messages by type → only matching types shown
8. All pages deep-linkable (paste URL → correct page renders)
9. Browser back/forward works across all new routes
10. Leave dashboard open 30+ min → memory stable (no unbounded growth)
11. Messages page loads only recent 100 messages; "Load older" fetches more
12. Search → click message → channel loads, message highlighted
