---
name: tdd-implementation-loop
description: Use when an agent must write code via test-driven development. Defines the types-stubs-red-green-refactor cycle with build verification. The last action before finishing must be a successful build with all tests passing.
axis: protocol
---

***ACCESS SCOPE: write-access***

# TDD Implementation Loop

Core protocol for any agent that writes code and must verify both compilation and correctness.

## Preamble

1. **Read** each file before modifying it.
2. **Follow instructions precisely.** Do not add features, refactors, or improvements not in the plan.
3. **Prefer editing** existing files over creating new ones.

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

For each unit of work in the phase, execute these steps in order:

### Step 1 -- Define the Contract

Types, interfaces, data structures. These are the nouns of the work. The codebase should typecheck after this step (no new logic, just shapes).

### Step 2 -- Stub the Behavior

Function signatures with minimal bodies that compile but do no real work. Examples:

- TypeScript: `throw new Error("not implemented")` or return a type-correct default
- C++: `checkf(false, TEXT("Not implemented"))` or `ensure(false)`

The codebase must **build** after this step. Every call site resolves, every import works.

### Step 3 -- Write Failing Tests (Red)

Tests that assert the behavioral requirements against the stubs. Run them. They **must fail**. If a test passes against a stub, it is testing nothing: tighten the assertion or delete the test.

### Step 4 -- Implement Until Green (Green)

Fill in function bodies one at a time, running tests after each. Stop as soon as all tests pass. Do not add behavior that no test demands.

### Step 5 -- Refactor

Clean up duplication, improve names, extract helpers, but only while tests stay green. No new behavior in this step.

## Build Verification

After completing the TDD cycle:

- **Build** and verify a clean build.
- **Run all tests** and verify they pass.
- **If the build or tests fail**, read the errors and fix them yourself. Iterate until both pass (max 3 attempts).
- **If you cannot achieve a clean build and passing tests** after 3 attempts, stop and report what is failing.

## Completion Rule

**The last thing you do before finishing must be a successful build with all tests passing against your final code.**

Any file modification after a successful build invalidates it -- you must build and test again.

Do not:
- Summarise and stop without having built and tested.
- Assume your code is correct without compiling and testing it.
- Make any file changes after your last build without rebuilding.

## Scope Constraint

If your write scope is restricted to certain directories (e.g. test directories only), honour that restriction absolutely. Flag files outside your scope that need changes and return without modifying them.
