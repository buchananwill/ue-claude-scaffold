---
title: "Auto-sync on task creation not working"
priority: medium
reported-by: interactive-session
date: 2026-03-23
status: done
---

## Problem

The CLAUDE.md documentation states that the coordination server auto-syncs when tasks are created,
meaning `POST /sync/plans` should not be needed before `POST /tasks`. However, when posting tasks
with a `sourcePath` referencing a recently committed plan file, the server returns:

```
422 Unprocessable Entity
Task 0: sourcePath 'Notes/buildables/selection-context-activation-plan.md' not found on branch
'docker/current-root' in bare repo. Commit the plan in the exterior repo, then call POST /sync/plans
to sync.
```

The plan was committed in the exterior repo before the task creation request. A manual
`POST /sync/plans` call resolved it, after which the task creation succeeded.

## Expected Behaviour

`POST /tasks` (and `POST /tasks/batch`) should auto-sync from the exterior repo before validating
`sourcePath`, as documented. The manual sync step should be unnecessary.

## Reproduction

1. Commit a new plan file in the exterior repo.
2. Immediately `POST /tasks/batch` referencing the plan in `sourcePath`.
3. Observe 422 error about missing file on `docker/current-root`.
4. `POST /sync/plans` manually.
5. Retry `POST /tasks/batch` — succeeds.
