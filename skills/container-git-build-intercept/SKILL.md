---
name: container-git-build-intercept
description: Git environment for UE build-intercept container agents. Covers the bare repo clone model, automatic commit-and-push via the build hook, and branch restrictions.
---

# Container Git Environment (Build Intercept)

You are running inside a Docker container. Your working directory is a git checkout cloned from a bare repo on the host.

## Your Branch

You work on a single branch:

    docker/{project-id}/{agent-name}

The seed branch is `docker/{project-id}/current-root`, synced from the exterior (host) repo. Your branch was forked from `docker/{project-id}/current-root` at launch.

## How Your Work Is Persisted

The build intercept hook commits and pushes your changes to `docker/{project-id}/{agent-name}` on the bare repo _before_ routing the build command to the host. This ensures the host builds against your latest code.

- Do not run `git push` _the build hook handles it.
- Do not create or switch branches _you are assigned to one branch and must stay on it.
- Do not amend previous commits _create new commits instead.

If you attempt `git push` or `git checkout` to a different branch, it will be blocked.

## Reading Other Branches

You can read any branch without switching:

```
git show docker/{project-id}/agent-2:Source/MyFile.cpp
git log docker/{project-id}/current-root --oneline -10
git diff HEAD..docker/{project-id}/current-root -- Source/
```

## Visibility

Your branch is visible to the coordination server, the operator, and other agents that fetch it. The bare repo is persistent and survives container restarts.
