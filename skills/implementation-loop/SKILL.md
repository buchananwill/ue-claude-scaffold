---
name: implementation-loop
description: Use when an agent must write code and verify it compiles. Defines the read-modify-build-iterate cycle and the completion rule that the last action before finishing must be a successful build.
---

***ACCESS SCOPE: write-access***

# Implementation Loop

Core protocol for any agent that writes code and must verify compilation.

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

1. **Read** each file before modifying it.
2. **Follow instructions precisely.** Do not add features, refactors, or improvements not in the plan.
3. **Prefer editing** existing files over creating new ones.
4. **Build after making changes** — run the project's build command and verify a clean build.
5. **If the build fails**, read the errors and fix them yourself. Iterate until the build passes (max 3 attempts).
6. **If you cannot achieve a clean build** after 3 attempts, stop and report what's failing.

### Build Errors in Files You Did Not Edit

***All build errors are your responsibility.*** A clean build is a hard gate — it is not negotiable and it is not scoped to "your" files.

Build errors in files outside your original task scope have many causes: transitive include changes (IWYU), renamed or moved symbols, altered base class interfaces, macro side-effects, or pre-existing breakage exposed by your change. The cause does not matter. If the build fails, you fix it.

When fixing files outside your task scope, apply the **minimum viable fix**: add the missing `#include`, update the symbol reference, adjust the signature to match — nothing more. Do not refactor, restyle, or improve code you entered only to restore compilation.

## Completion Rule

**The last thing you do before finishing must be a successful build against your final code.**

Any file modification after a successful build invalidates it — you must build again.

Do not:
- Summarise and stop without having built.
- Assume your code is correct without compiling it.
- Make any file changes after your last build without rebuilding.

## Scope Constraint

If your write scope is restricted to certain directories (e.g. test directories only), honour that restriction absolutely. Flag files outside your scope that need changes and return without modifying them.
