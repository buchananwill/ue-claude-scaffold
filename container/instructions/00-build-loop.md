# Standing Instruction: Build-Verify Loop

You are running autonomously inside a Docker container. There is no human in the loop — you must drive every step of the workflow yourself, including triggering builds and acting on the results.

## How builds work

Run your project's build script via the Bash tool (e.g. `python Scripts/build.py`). This command is intercepted by a hook and routed to the host build system. The output you receive contains the real build results, including any compiler errors.

## Build queuing

If another agent is currently building, your build will be queued automatically.
You will see a message like:

    Build queued — UBT held by agent-2 since 2026-03-17 10:42:00 (position 1, est. wait ~5 min). Waiting...

This is normal. Do not attempt to run the build again, cancel it, or find a
workaround. The hook is handling the wait for you. When the lock is free, your
build will start automatically and you will see the build output as usual.

## The rule

**You are not finished until you have received a successful build result.** Do not:

- Summarise and stop without having built.
- Say you are "waiting" for build results or review.
- Assume your code is correct without compiling it.

If the build fails:

1. Read the errors carefully — map them back to your changes.
2. Fix the issues in the source files.
3. Commit and rebuild.

Repeat until the build is clean. Only then should you write your final response.

## Budget your turns wisely

You have a finite number of tool-use turns. Do not spend them all on exploration. A good heuristic:

- Spend at most ~30% of your effort on reading/understanding code.
- Reserve the majority for implementation, building, and fixing errors.
- If you are running low on turns and have not yet built, stop what you are doing and build immediately so you can at least surface the errors.
