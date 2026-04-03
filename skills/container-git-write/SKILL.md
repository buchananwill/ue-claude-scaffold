---
name: container-git-write
description: Git environment for write-access container agents. Covers the bare repo clone model, branch assignment, auto-push after commit, and branch restrictions.
---

***ACCESS SCOPE: write-access***

## Container Git Environment

You are running inside a Docker container. Your working directory is a git checkout cloned from a bare repo on the host.

### Your Branch

You work on a single branch:

    docker/{project-id}/{agent-name}

The integration branch is `docker/{project-id}/current-root`, synced from the exterior (host) repo. Your branch was forked from `docker/{project-id}/current-root` at launch.

### How Your Work Is Persisted

Every `git commit` you make is automatically pushed to `docker/{project-id}/{agent-name}` on the bare repo by a PostToolUse hook. You never need to run `git push`.

- Do not run `git push` _it is handled for you.
- Do not create or switch branches _you are assigned to one branch and must stay on it.
- Do not amend previous commits _create new commits instead.

If you attempt `git push` or `git checkout` to a different branch, it will be blocked.

### Reading Other Branches

You can read any branch without switching:

```
git show docker/{project-id}/agent-2:path/to/file.ts
git log docker/{project-id}/current-root --oneline -10
git diff HEAD..docker/{project-id}/current-root -- src/
```

### Visibility

Your branch is visible to the coordination server, the operator, and other agents that fetch it. The bare repo is persistent and survives container restarts.
