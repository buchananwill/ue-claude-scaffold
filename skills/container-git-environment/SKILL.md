---
name: container-git-environment
description: Use for any agent running inside a Docker container that interacts with the project's git repository. Explains the bare repo clone model, branch naming, and push interception.
---

# Container Git Environment

Containers interact with a bare git repository on the host. This skill describes the git data flow.

## Branch Model

Each container agent works on its own branch:

    docker/{agent-name}

The integration branch is `docker/current-root`, which is synced from the exterior (host) repo. Agent branches fork from `docker/current-root` on first launch.

## Clone and Push

The container's entrypoint clones from the bare repo at startup. Your working directory is a normal git checkout of your agent's branch.

**Manual `git push` is blocked.** A PreToolUse hook (`block-push-passthrough.sh`) intercepts and rejects direct push commands. Pushes happen automatically as part of the build hook — when you run a build command, the hook commits and pushes your changes to `docker/{agent-name}` before routing the build to the host.

## Visibility

- Your branch is visible to the coordination server and other agents that fetch it.
- After a successful build, other agents (or the human operator) can see your changes by fetching your branch:
  ```
  git fetch origin docker/{agent-name}
  git diff HEAD FETCH_HEAD
  ```
- The bare repo is persistent — it is created once by `setup.sh` and never recreated on launch.
