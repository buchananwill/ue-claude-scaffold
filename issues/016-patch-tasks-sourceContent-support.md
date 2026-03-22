---
title: "PATCH /tasks/:id should support sourceContent updates (or explain why not)"
priority: medium
reported-by: interactive-session
date: 2026-03-21
---

## Problem

`PATCH /tasks/:id` rejects `sourceContent` and `targetAgents` as unknown fields. The only accepted
fields are: `title`, `description`, `sourcePath`, `acceptanceCriteria`, `priority`, `files`,
`dependsOn`.

This means there is no way to update the plan content of a plan-mode task after creation. The
workaround is delete + recreate, which changes the task ID and loses any prior status/messaging
history.

## Expected Behaviour

One of:

1. **Support `sourceContent` on PATCH** — write the updated content to the bare repo at the existing
   `sourcePath`, commit it, and optionally accept `targetAgents` to re-merge into agent branches.
   This is the full CRUD expectation: if POST accepts `sourceContent`, PATCH should too.

2. **If there is a reason not to** (e.g. plan immutability after creation is intentional), then the
   error message should say so explicitly. Currently the error is generic:
   ```
   "Unknown fields: sourceContent, targetAgents. Valid fields: title, description, ..."
   ```
   A better message would be:
   ```
   "sourceContent cannot be updated after task creation. Delete and recreate the task instead."
   ```

## Constraint

`sourceContent` patches must only be allowed on `pending` tasks — same gate as the existing PATCH
fields. A claimed task's plan is a contract with the agent executing it; mutating it mid-flight is a
recipe for chaos. If the plan needs correction after claiming, wait for the task to complete and then
course-correct with a follow-up task.

## Context

Hit this while renaming "Piste-a-pedia" → "Piste-o-pedia" across a plan. Had to delete task #30 and
recreate as #31 to get the corrected plan content onto the bare repo.
