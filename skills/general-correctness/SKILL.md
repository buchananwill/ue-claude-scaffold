---
name: general-correctness
description: Use when reviewing any codebase for logic errors, spec compliance, boundary conditions, and test coverage gaps. Universal correctness truths independent of language or framework.
---

# General Correctness Domain Knowledge

Universal correctness concerns applicable to any codebase. These are truths about software, not about any specific language or framework.

## Specification Compliance

For each requirement in the spec:
- Does the implementation satisfy it **completely**?
- Is it only partially addressed?
- Was anything introduced that the spec did NOT ask for?
- Are edge cases from the spec handled?

## Behaviour Fidelity

The plan defines a non-negotiable behaviour contract: the inputs the code accepts, the outputs it returns, the invariants it maintains, the side effects it performs, the edge cases it handles. The implementation must produce **exactly that behaviour**. A function that omits an edge case, returns a value the spec does not describe, or skips a side effect is BLOCKING regardless of how clean the code reads.

Code samples in the plan (signatures, type sketches, snippets) are best-effort guidance, not part of the contract. The implementer is allowed — and expected — to adapt sample shapes when they conflict with standing style or best-practice rules in the project's loaded domain skills, provided the adaptation preserves the specified behaviour. Do not flag such adaptations as fidelity deviations. Do flag any change that alters what the code can compute, return, or affect.

When evaluating a deviation:
- If the surface differs (parameter name, helper structure, idiom) but the behaviour is identical, it is **not a fidelity finding**. It may still be a style finding if the adaptation breaks a different rule.
- If the behaviour differs (a missing edge case, an extra side effect, a relaxed invariant, a parameter added or removed in a way that changes what the function can express), it is BLOCKING.

### Anti-Paraphrase Rule

Watch for language in the implementation, its JSDoc, or its debrief that reframes the **behaviour** as aspirational:

- "The spec says X but **in practice we need** Y."
- "The spec's X is **shorthand** for Y."
- "The **critical invariant** the spec requires **is preserved**..." (when the invariant has actually been weakened)
- "Captured in the closure **rather than passed per-row**..." (when the change affects what the behaviour can express)
- "The spec's **intent** is..." / "What the spec actually means..."
- "**Effectively equivalent** to..." / "**Functionally the same** as..."
- "The real requirement is..."

When any such phrase argues the behaviour has been replaced with a looser invariant, it is BLOCKING. Do not accept the paraphrase as a valid framing, regardless of how internally consistent the alternative invariant sounds. The fix is to restore the literal behaviour, or to escalate the behaviour as undeliverable. See `review-output-schema` for the finding-resolution protocol.

When a similar phrase explicitly justifies a code-sample adaptation against a named style or best-practice rule (e.g., "Adapted the sample signature to satisfy <rule from loaded skill>; behaviour unchanged: <evidence>"), it is **not** a fidelity finding. Verify the behaviour claim against the diff before accepting; if the behaviour is preserved, allow it.

## Logic Correctness

- Off-by-one errors, especially in aligned-array or indexed-collection access
- Boundary conditions (empty containers, zero-size inputs, max values)
- Logic errors in conditionals and loops
- Incorrect assumptions about function contracts or return values
- Missing null/validity checks at system boundaries
- Wrong comparison operators, inverted conditions
- Short-circuit evaluation assumptions

## Test Coverage Gaps

- Does the diff introduce logic paths that have no test coverage?
- Are edge cases exercised (empty input, max values, boundary conditions)?
- Flag specific untested scenarios — don't just say "needs more tests."

## Review Discipline

For each changed function:
- Trace the logic path for normal inputs, edge cases, and error conditions.
- Check loop bounds, array indices, and conditions.
- Verify function contracts (preconditions, postconditions) are maintained.
