---
title: "Atomic task creation: accept plan content inline, write to repo, push task in one call"
priority: high
reported-by: interactive-session
date: 2026-03-19
---

# Atomic task creation with plan payload

## Problem

Creating a task that references a plan file currently requires three manual steps from the
interactive session:

1. Write plan file to worktree, commit, merge to `docker/current-root`
2. Push task to `POST /tasks` referencing the plan path
3. Hope the path is correct and the file actually exists on the branch

This is fiddly, error-prone, and creates a window where the task can reference a file that
doesn't exist yet. The server currently accepts any path string without validation — a task
can be created pointing to a nonexistent plan, which the container agent will fail on silently.

## Proposed design

A single `POST /tasks` endpoint that accepts both the task record **and** the plan content:

```json
{
  "title": "Actor selector: span predicate + draft categories",
  "description": "Brief summary for dashboard display",
  "acceptanceCriteria": "Builds cleanly. 4 tests pass.",
  "priority": 1,
  "sourcePath": "Notes/ui/actor-selector-categories-plan.md",
  "sourceContent": "---\ntitle: Actor Selector Categories...\n---\n\n# Full plan markdown..."
}
```

The server:

1. Writes `sourceContent` to `sourcePath` on `docker/current-root` (commit to the bare repo
   directly, or write + commit + push from a temp checkout)
2. Inserts the task record into the database with `sourcePath` as a validated field
3. Returns the task ID and commit SHA

If `sourceContent` is omitted but `sourcePath` is provided, the server validates that the file
exists at that path on `docker/current-root` HEAD before accepting the task. If it doesn't
exist, reject with 422.

## Benefits

- **One-shot action** — the interactive session calls one endpoint and is done
- **No divergence** — the plan file on the branch and the task record are created atomically
- **Path validation** — impossible to create a task referencing a missing plan
- **Simpler interactive workflow** — no manual commit/merge/push dance

## Scope

- Modify `POST /tasks` to accept optional `sourcePath` and `sourceContent` fields
- Add git write logic (commit to `docker/current-root` branch in the bare repo)
- Add path validation when `sourcePath` is provided without `sourceContent`
- Return 422 with clear error message on validation failure

## Migration

Existing tasks without `sourcePath` are unaffected. The field is optional — tasks without plans
(e.g. simple bug fixes described entirely in the description) continue to work as before.
