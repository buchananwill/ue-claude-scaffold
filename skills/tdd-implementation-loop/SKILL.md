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

## The Behaviour Contract

The plan defines a **non-negotiable behaviour contract**. The behaviour your code must produce — the inputs it accepts, the outputs it returns, the invariants it maintains, the side effects it performs, the edge cases it handles — is literal and not open to interpretation. If your code does not do exactly what the plan says, your code fails.

Code samples in the plan (function signatures, type sketches, snippets) are **best-effort guidance**, not part of the contract. Their job is to communicate the intended shape of the work; they may have been written quickly, in pseudo-code, or before the plan author audited them against standing style and best-practice rules. When a code sample conflicts with the style or best-practice guidance in your loaded domain skills, follow the style/best-practice and adapt the sample — the behaviour the sample is illustrating must still be delivered exactly. Always state the adaptation plainly in your debrief or commit message: name the rule that drove it and confirm the behaviour is unchanged.

Acceptable adaptation (behaviour preserved):
- Renaming a parameter to match the project's naming convention while keeping its position, type, and semantics.
- Splitting a sample function into smaller helpers when the loaded decomposition skill demands it, provided the public entry point still produces the specified behaviour.
- Substituting a sample's idiom with the project-standard one (e.g., a typed enum the project mandates) when the swap preserves what the code can compute.

Unacceptable adaptation (behaviour altered):
- Dropping or adding a parameter that changes what the function can compute.
- Returning a different type that loses or invents information the plan said the caller would receive.
- Skipping a side effect, an invariant check, or an edge case the plan calls out.
- Reframing a literal "the function must do X" into "the function effectively does X-ish".

If the behaviour itself is undeliverable — internally contradictory, impossible to achieve given real constraints, or a cursed design — **STOP**. Do not interpret. Do not partially deliver. Post a message on the `general` channel with `type: "escalation"`, referencing your task ID and naming exactly which behaviour is undeliverable and why. Then halt. Refusing to complete an impossible design is correct behavior; silent reinterpretation is not.

### Watch-Phrases for Behaviour Paraphrase

If you find yourself writing any of these phrases about the **behaviour** specified in the plan, STOP — you are paraphrasing the contract:

- "in practice we need..." (about what the behaviour must do)
- "the critical invariant is preserved..." (when the invariant has actually been weakened)
- "captured in the closure rather than passed..." (when this changes what the behaviour can express)
- "the spec's intent is..." / "what the spec actually means..."
- "effectively equivalent to..." / "functionally the same as..."
- "the real requirement is..."

These phrases are alarms when applied to behaviour. Adapting a code sample's surface to standing style is a different action — and you must say so plainly: "Adapted the sample signature to match <named rule from loaded skill>; behaviour unchanged: <evidence>." Revert any behaviour deviation to match the literal spec, or escalate — do not proceed.

### Review-Cycle Response

A BLOCKING review finding on a behaviour-fidelity issue has exactly two valid responses:

1. **Restore** the specified behaviour so the implementation matches the plan.
2. **Escalate** the behaviour as undeliverable, and halt.

Adding documentation, JSDoc, or commit-message prose that explains the deviation is NOT a valid response. Deferring the behaviour to a later phase is NOT a valid response. Renaming the deviating function or type without restoring the behaviour is NOT a valid response. If you cannot restore the behaviour without breaking other committed work in the same phase, that is an escalation event — report it on the `general` channel with `type: "escalation"` and halt.

A BLOCKING finding that targets a code-sample adaptation (you adapted the sample to standing style and the reviewer flagged it as deviation) has a third valid response: name the style/best-practice rule that drove the adaptation, cite the loaded domain skill that mandates it, and demonstrate that the behaviour is unchanged. The reviewer is responsible for accepting a justified, behaviour-preserving style adaptation.

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

### Build Errors in Files You Did Not Edit

***All build errors are your responsibility.*** A clean build is a hard gate — it is not negotiable and it is not scoped to "your" files.

Build errors in files outside your original task scope have many causes: transitive include changes (IWYU), renamed or moved symbols, altered base class interfaces, macro side-effects, or pre-existing breakage exposed by your change. The cause does not matter. If the build fails, you fix it.

When fixing files outside your task scope, apply the **minimum viable fix**: add the missing `#include`, update the symbol reference, adjust the signature to match — nothing more. Do not refactor, restyle, or improve code you entered only to restore compilation.

## Completion Rule

**The last thing you do before finishing must be a successful build with all tests passing against your final code.**

Any file modification after a successful build invalidates it -- you must build and test again.

Do not:
- Summarise and stop without having built and tested.
- Assume your code is correct without compiling and testing it.
- Make any file changes after your last build without rebuilding.

## Scope Constraint

If your write scope is restricted to certain directories (e.g. test directories only), honour that restriction absolutely. Flag files outside your scope that need changes and return without modifying them.
