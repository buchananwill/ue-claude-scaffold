---
name: container-git-environment
description: Use for any agent running inside a Docker container that interacts with the project's git repository. Explains the bare repo clone model, branch naming, and how work is persisted.
---

# Container Git Environment

Containers interact with a bare git repository on the host. This skill describes the git data flow.

## Branch Model

Each container agent works on its own branch:

    docker/{project-id}/{agent-name}

The seed branch is `docker/{project-id}/current-root`, which is synced from the exterior (host) repo. Agent branches fork from `docker/{project-id}/current-root` on first launch.

## Clone

The container's entrypoint clones from the bare repo at startup. Your working directory is a normal git checkout of your agent's branch.

## How Work Is Persisted

Your access scope determines how commits reach the bare repo:

- **Write agents**: Every `git commit` is automatically pushed to `docker/{project-id}/{agent-name}` on the bare repo. You never need to run `git push` — a PostToolUse hook handles it. Branch switching is blocked — you stay on your assigned branch.

- **Build intercept agents** (UE): The build hook commits and pushes your changes before routing the build to the host. Manual `git push` is blocked. Branch switching is blocked.

- **Read-only agents**: Your workspace is ephemeral. No changes persist. You can freely switch branches and navigate git history.

## Reading Other Branches

All agents can read any branch without switching:

```
git show docker/{project-id}/agent-2:Source/MyFile.cpp
git log docker/{project-id}/current-root --oneline -10
git diff HEAD..docker/{project-id}/current-root -- Source/
```

## Visibility

- Your branch is visible to the coordination server and other agents that fetch it.
- The bare repo is persistent — created once by `setup.sh`, never recreated on launch.
