# Standing Instruction: Build-Verify Loop

You are running autonomously inside a Docker container. There is no human in the loop — you must drive every step of the workflow yourself, including triggering builds and acting on the results.

## How builds work

Run your project's build script via the Bash tool (e.g. `python Scripts/build.py`). A PreToolUse hook intercepts this command and routes it to the Windows host where the Unreal Engine is installed. The output you receive is the real compiler output from the host.

**CRITICAL:** You are in a Linux container, but builds run on the Windows host via hook interception. **Do NOT skip the build because you are running in Linux.** Do NOT say "cannot build in this environment" or "requires Windows". Just run the build command — the hook handles everything transparently. You will receive real UE compiler output as if you ran it locally.

## Build queuing

If another agent is currently building, your build will be queued automatically.
You will see a message like:

    Build queued — UBT held by agent-2 since 2026-03-17 10:42:00 (position 1, est. wait ~5 min). Waiting...

This is normal. Do not attempt to run the build again, cancel it, or find a
workaround. The hook is handling the wait for you. When the lock is free, your
build will start automatically and you will see the build output as usual.

## The rule

**The last thing you do before finishing must be a successful build against your final code.** Any commit after a successful build invalidates it — you must build again.

Do not:

- Summarise and stop without having built.
- Say you are "waiting" for build results or review.
- Assume your code is correct without compiling it.
- Claim that the environment cannot build — it can, via the hook.
- Make fix-ups, style changes, or any other commits after your last build without rebuilding.

If the build fails:

1. Read the errors carefully — map them back to your changes.
2. Fix the issues in the source files.
3. Commit and rebuild.

Repeat until the build is clean.

## Completion sequence

When you are ready to finish, do these three things in order:

1. **Commit your code and debrief together, then build.** The debrief file (see `01-debrief.md`) is part of the verified commit. This build is your final build. It must succeed.

2. **Post a `summary` message to the `general` channel.** This is a curl call — no files are modified, no rebuild needed. Include: task title, build outcome, key files changed. This is your sign-off.

## Budget your turns wisely

You have a finite number of tool-use turns. Do not spend them all on exploration. A good heuristic:

- Spend at most ~30% of your effort on reading/understanding code.
- Reserve the majority for implementation, building, and fixing errors.
- If you are running low on turns and have not yet built, stop what you are doing and build immediately so you can at least surface the errors.
