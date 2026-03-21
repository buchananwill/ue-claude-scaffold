---
title: "Dashboard doesn't surface why a task can't be claimed"
priority: high
reported-by: interactive-session
date: 2026-03-20
status: done
---

# Dashboard doesn't surface why a task can't be claimed

## Problem

Task 23 had the highest priority (8) but was never claimed by any agent. The reason: its
`sourcePath` pointed to a plan file that no longer existed in the bare repo. The `claim-next`
endpoint silently skipped it every poll cycle. The dashboard showed it as "pending" with no
indication that anything was wrong.

From the operator's perspective, the task looked healthy — pending, high priority, should have been
picked up first. The actual blocker was invisible.

## What should happen

The dashboard (and/or the API) should surface claim-blocking reasons:

1. **Missing sourcePath** — the plan file doesn't exist on the plan branch. This is a data
   integrity issue that needs operator intervention.
2. **File-lock conflicts** — another agent owns overlapping files. This is transient and resolves
   when the other agent completes.
3. **Unmet dependencies** — (once issue #007 lands) blocked by incomplete prerequisite tasks.

## Proposed approach

### API: add a `blockReason` field to task responses

When returning tasks via `GET /tasks` or `GET /tasks/:id`, the server could compute and include a
`blockReason` for pending tasks:

```json
{
  "id": 23,
  "status": "pending",
  "blockReason": "sourcePath 'plans/game-and-player-init-overhaul.md' not found on docker/current-root"
}
```

Or keep it lightweight — add a `GET /tasks/:id/claimability` endpoint that checks all the claim
preconditions and returns a structured result without actually claiming.

### Dashboard: visual distinction for blocked tasks

- Pending tasks with a `blockReason` should be visually distinct (e.g. warning icon, amber tint).
- Hovering or clicking shows the reason.
- "Missing sourcePath" should be prominently flagged — it won't resolve on its own.
