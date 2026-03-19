---
title: "Add GET /tasks/:id/source convenience endpoint"
priority: low
reported-by: interactive-session
date: 2026-03-19
---

# Add GET /tasks/:id/source convenience endpoint

When a task has a `sourcePath`, the worker must independently know to read that file from the git worktree.
A `GET /tasks/:id/source` endpoint that returns the file content (from the staging worktree or bare repo)
would make the source document immediately accessible via the same API surface the worker is already using.
