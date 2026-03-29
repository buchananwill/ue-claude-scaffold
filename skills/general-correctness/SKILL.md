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
