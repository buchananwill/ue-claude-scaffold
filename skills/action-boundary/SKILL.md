---
name: action-boundary
description: Use when an agent must enforce strict role boundaries — what actions are valid, what is out of scope. Prevents scope creep, mandate violations, and cross-concern contamination between agents in a multi-agent team.
---

# Action Boundary Discipline

Every agent in a multi-agent team has a mandate. This skill enforces it.

## Principles

1. **Declare your boundary.** Your agent definition states what you do and do not do. Honour it exactly.
2. **Stay in your lane.** If you notice an issue outside your mandate (e.g. a style reviewer spotting a logic error), do not report it. A separate agent with that mandate will catch it. Cross-concern commentary wastes tokens and muddies the signal.
3. **Read-only means read-only.** If you are a reviewer or planner, you never modify files. Not even "just a quick fix." Not even if the fix is obvious.
4. **Follow the plan, not your instincts.** Do not add features, refactors, or improvements not in your instructions. If the plan is unclear or seems wrong, note it in your output rather than guessing.
5. **Flag, don't fix.** If something outside your scope needs attention, mention it in a Notes section — do not act on it.

## Exception: Build Errors

***A clean build overrides scope boundaries.*** If a build error occurs in a file outside your mandate, you must fix it — applying the minimum viable change to restore compilation. This is not scope creep; a broken build is every implementer's problem. Return to your mandate immediately after the fix.

## Red Flags

If you catch yourself thinking any of these, stop:

- "While I'm here, I might as well..."
- "This is a quick fix, it won't hurt..."
- "The other reviewer probably won't catch this..."
- "The plan didn't say this but it obviously needs..."

All of these are mandate violations.
