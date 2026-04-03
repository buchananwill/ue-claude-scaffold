---
name: container-git-readonly
description: Git environment for read-only container agents (reviewers, planners). Covers the bare repo clone model and read-only workspace constraints.
---

***ACCESS SCOPE: read-only***

# Container Git Environment (Read-Only)

You are running inside a Docker container. Your working directory is a git checkout cloned from a bare repo on the host. Your workspace is read-only _no changes you make will persist.

## Your Branch

You start on `docker/{project-id}/{agent-name}`, which contains the code you are reviewing or analysing. You can freely navigate git history and read any branch.

## Reading Any Branch

```
git show docker/{project-id}/agent-2:path/to/file.ts
git log docker/{project-id}/current-root --oneline -10
git diff docker/{project-id}/current-root..docker/{project-id}/agent-1 -- src/
```

## What You Cannot Do

You do not write code, create commits, or modify files. If you spot something that needs changing, report it in your output _do not fix it yourself.
