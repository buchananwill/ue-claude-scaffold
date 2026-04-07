---
title: "Dashboard tasks page filters and sorts after pagination, not before"
priority: high
reported-by: interactive-session
date: 2026-04-07
status: open
---

# Dashboard tasks page filters and sorts after pagination, not before

## Problem

The tasks page on the dashboard applies filtering and sorting to whichever page of tasks the backend has already returned. The result is that the controls do not mean what the user expects:

- **Sorting by ID does not put the largest or smallest IDs on page 1.** It puts whichever IDs happened to be in the page the fetch already returned, reordered among themselves. To see the actual smallest or largest IDs the user must manually navigate to the page that contains them, which defeats the purpose of sorting.
- **Filtering by status can produce a page with zero results while the next page has some.** A status filter is applied to one page's worth of tasks at a time, so matching tasks can be scattered across pages according to the original fetch order, with many empty pages in between.
- **Filtering by agent or priority has the same problem** — the displayed count depends on how many tasks on the current page happen to match, not on the real number of matches in the dataset.

This is a fundamental usability break. Filters and sort controls on a paginated list must describe a query over the whole dataset, not a transformation of one page.

## Root cause

`dashboard/src/hooks/useTasks.ts` fetches `/tasks?limit=20&offset=...&status=<optional>`. The `status` parameter is the only filter forwarded to the backend, and there is no sort parameter at all.

`dashboard/src/hooks/useTaskFilters.ts:58-93` receives the already-fetched page and applies the status, agent, and priority filters plus the sort comparator client-side, inside a `useMemo` block. Because this runs after the fetch has paginated the data, every filter and sort operates on one page of twenty tasks rather than on the full task set.

The URL-backed variant at `useTaskFilters.ts:154-223` encodes filter and sort state into search params for deep-linking, but still drives the same client-side `useFilteredTasks` transform. The search params are not passed to the `/tasks` request.

## Required behavior

- Filters (status, agent, priority, and any other filter the UI exposes) must be sent as parameters on the `GET /tasks` request and applied server-side, before pagination.
- Sort (column and direction) must be sent as parameters on the `GET /tasks` request and applied server-side, before pagination. Sorting by ID descending must put the largest IDs on page 1, regardless of the total task count.
- The reported page count and total result count on the dashboard must reflect the filtered-and-sorted dataset, not the unfiltered dataset. A filter that matches ten tasks across a database of two thousand must produce one page of ten results, not one hundred pages with ten scattered matches.
- Changing a filter or sort must reset the pagination cursor. The user cannot land on page 5 of a new filter they just applied.
- Empty results must be distinguishable at the page level. If the filter matches zero tasks, the page displays "no matching tasks" once, not "page 1 of 1 (empty)" alongside navigation controls to other empty pages.
- Deep-linking via URL search params must continue to work. A link containing `?status=failed&sort=id&dir=desc&page=2` must reproduce the same view on another session, and that view must be driven by a server-side query with those same parameters.
- Polling (the tasks page auto-refreshes) must preserve filter and sort state across refreshes without re-flashing an unfiltered intermediate state.

## Acceptance criteria

- Sorting the tasks table by ID descending shows the largest ID in the database in the first row of page 1, for any database size.
- Applying a status filter that matches N tasks produces `ceil(N / pageSize)` pages of results, all populated up to the last.
- Changing any filter while viewing page 3 returns the user to page 1 of the new result set.
- The `GET /tasks` request URL shown in the browser network tab includes filter and sort parameters matching the active UI state.
- The total task count displayed on the page matches the count returned by the server for the active filter, not the unfiltered count.
- Removing all filters and sort restores the default view without requiring a manual page reload.
- A link copied from the URL bar and opened in a fresh tab reproduces the same filtered, sorted, paginated view.

## Sequencing

Not blocked by the shell-script-decomposition plan. The server's `/tasks` endpoint and the dashboard's task page are both outside the scope of that plan. This can be worked on in parallel. The server may already accept a subset of filter parameters (status is currently forwarded); whoever picks this up should verify the current server capability, extend it as needed, and then update the dashboard to rely on the server-side query.
