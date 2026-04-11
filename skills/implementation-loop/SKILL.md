---
name: implementation-loop
description: Use when an agent must write code and verify it compiles. Defines the read-modify-build-iterate cycle and the completion rule that the last action before finishing must be a successful build.
---

***ACCESS SCOPE: write-access***

# Implementation Loop

Core protocol for any agent that writes code and must verify compilation.

## Hard Design Constraints

Specifications for types and function signatures in the plan are **hard design constraints**. They take precedence over existing patterns you find in the code. They are **NOT open to interpretation**.

When the plan gives you a function signature, that signature is the contract. If the existing call-site has more parameters, different parameter names, or extra context threaded through, that existing shape is evidence of what the plan is telling you to escape -- not a boundary the new code must respect. You are not porting the existing signature; you are implementing the plan's signature. Pattern-matching to existing code feels like competence from the inside and produces silent drift. Do not hedge by "threading it through to be safe" -- the plan author has already considered and rejected that shape.

If you encounter a contradiction, an impossible request, or a design you cannot in good conscience implement, **STOP**. Do not interpret. Do not deviate silently. Report the problem via a message on the `general` channel with `type: "escalation"`, referencing your task ID and naming the specific contradiction. Then halt. Refusing to complete a poor-quality design is correct behavior; silent interpretation is not.

### Watch-Phrases

If you find yourself writing any of these phrases in a design decision, JSDoc, debrief, or commit message, STOP -- you are paraphrasing the spec to defuse its literal reading:

- "in practice we need..."
- "shorthand for..."
- "the critical invariant is preserved..."
- "captured in the closure rather than passed..."
- "the spec's intent is..." / "what the spec actually means..."
- "effectively equivalent to..." / "functionally the same as..."
- "the real requirement is..."

These are not escape hatches. They are alarms. The presence of any of them in your work means you have chosen interpretation over fidelity. Revert your change to match the literal spec, or escalate -- do not proceed.

### Review-Cycle Response

A BLOCKING review finding on a spec-fidelity issue has exactly two valid responses:

1. **Revert** the deviation so the implementation matches the literal spec.
2. **Escalate** the spec as impossible or underspecified, and halt.

Adding documentation, JSDoc, or commit-message prose that explains the deviation is NOT a valid response. Deferring formalization to a later phase is NOT a valid response. Renaming the deviating type without changing its shape is NOT a valid response. If you cannot revert the deviation without breaking other committed work in the same phase, that is an escalation event -- report it on the `general` channel with `type: "escalation"` and halt.

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
