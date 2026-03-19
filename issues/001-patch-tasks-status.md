---
title: "PATCH /tasks/:id should support status changes"
priority: medium
reported-by: interactive-session
date: 2026-03-19
---

# PATCH /tasks/:id should support status changes

Currently `PATCH /tasks/:id` only accepts `title`, `description`, `sourcePath`, `acceptanceCriteria`,
`priority`, and `files`. There is no way to cancel or otherwise change the status of a task via the API.

The dashboard can delete tasks, but the API cannot. This means interactive sessions that create test tasks
or tasks with errors cannot clean them up programmatically.

**Suggestion:** Either add `status` to the PATCH allowed fields (with valid transitions enforced), or add
a `DELETE /tasks/:id` endpoint that cancels/removes a task.
