---
title: Tasks list needs server-side pagination
priority: medium
reported-by: user
date: 2026-03-28
---

# Tasks List Needs Server-Side Pagination

## Problem

The server's `GET /tasks` endpoint defaults to `limit=50`, and the dashboard calls it with no params. Tasks beyond the first 50 (by `priority DESC, id ASC`) are invisible in the dashboard. Tasks 91-94 were hidden by this.

## Fix

1. **Keep the server default limit at 20** (not 50) for performance.
2. **Add `offset` query param** to `GET /tasks` for cursor/offset pagination.
3. **Dashboard: drive pagination via URL searchParams** (aligns with issue 033's request for searchParam-driven filters/sorting).
4. The dashboard's `useTasks` hook should accept page/offset from the URL and pass `?limit=20&offset=N` to the server.

## Related

- Issue 033 (buttons-should-be-links) — searchParam-driven filter state, sorting, and navigation persistence.
