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

## Specification Shape Fidelity

When the spec gives a type, interface, or function signature, the implementation must match its **literal shape**. A signature is not a sketch the implementer is free to enrich -- it is a contract. The spec's author has already chosen which parameters are part of the API and which are derived internally. If the spec declares `(table: string) => ...`, the outer function takes exactly one parameter. If the spec declares an interface with three fields, the implementation has three fields. Extra parameters, extra fields, or broadened config objects are BLOCKING deviations even when they are "internally consistent" or "more general."

### Anti-Paraphrase Rule

Watch for language in the implementation, its JSDoc, or its debrief that reframes the spec as aspirational:

- "The spec says X but **in practice we need** Y."
- "The spec's X is **shorthand** for Y."
- "The **critical invariant** the spec requires **is preserved**..."
- "Captured in the closure **rather than passed per-row**..."
- "The spec's **intent** is..." / "What the spec actually means..."
- "**Effectively equivalent** to..." / "**Functionally the same** as..."
- "The real requirement is..."

Any such phrase is a BLOCKING finding. It indicates the implementer has paraphrased a literal spec into a looser invariant and is claiming compliance against the paraphrase. The reviewer must not accept the paraphrase as a valid framing, regardless of how internally consistent the alternative invariant sounds. The fix is to revert the implementation to the literal spec shape, or escalate the spec as impossible. See `review-output-schema` for the finding-resolution protocol.

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
