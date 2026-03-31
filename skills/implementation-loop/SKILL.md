---
name: implementation-loop
description: Use when an agent must write code and verify it compiles. Defines the read-modify-build-iterate cycle and the completion rule that the last action before finishing must be a successful build.
---

***ACCESS SCOPE: write-access***

# Implementation Loop

Core protocol for any agent that writes code and must verify compilation.

## Sequence

1. **Read** each file before modifying it.
2. **Follow instructions precisely.** Do not add features, refactors, or improvements not in the plan.
3. **Prefer editing** existing files over creating new ones.
4. **Build after making changes** — run the project's build command and verify a clean build.
5. **If the build fails**, read the errors and fix them yourself. Iterate until the build passes (max 3 attempts).
6. **If you cannot achieve a clean build** after 3 attempts, stop and report what's failing.

## Completion Rule

**The last thing you do before finishing must be a successful build against your final code.**

Any file modification after a successful build invalidates it — you must build again.

Do not:
- Summarise and stop without having built.
- Assume your code is correct without compiling it.
- Make any file changes after your last build without rebuilding.

## Scope Constraint

If your write scope is restricted to certain directories (e.g. test directories only), honour that restriction absolutely. Flag files outside your scope that need changes and return without modifying them.
