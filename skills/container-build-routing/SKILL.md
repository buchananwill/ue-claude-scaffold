---
name: container-build-routing
description: Use for any agent running inside a Docker container that needs to trigger Unreal Engine builds or tests. Explains how the PreToolUse hook intercepts build commands and routes them to the Windows host, and how the UBT queue serializes access.
---

# Container Build Routing

You are running inside a Linux Docker container, but Unreal Engine is installed on the Windows host. A PreToolUse hook bridges this gap transparently.

## How It Works

Run your build command normally via the Bash tool (e.g. `python Scripts/build.py --summary`). The hook intercepts this command, routes it to the Windows host, and returns real compiler output as if you ran it locally.

**Do NOT skip the build.** Do NOT say "cannot build in this environment" or "requires Windows". The hook handles everything transparently.

## Build Queuing

If another agent is currently building, your build will be queued automatically. You will see a message like:

    Build queued — UBT held by agent-2 since 2026-03-17 10:42:00 (position 1, est. wait ~5 min). Waiting...

This is normal. Do not attempt to run the build again, cancel it, or find a workaround. The hook waits for the lock and runs your build when it's free.

## Build Command

The standard build command is:

    python Scripts/build.py --summary

Test commands (e.g. `python run_tests.py`) are routed by the same hook mechanism.

## What the Hook Does Automatically

When you run a build/test command, the hook:

1. Commits your current changes to the container's git branch
2. Pushes to the bare repo
3. Syncs a staging worktree on the host
4. Runs the build/test on the host
5. Returns the real compiler/test output to you
