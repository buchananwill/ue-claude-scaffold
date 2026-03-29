---
name: general-decomposition
description: Use when reviewing any codebase for file bloat, excessive nesting, DRY violations, hand-rolled algorithms, and decomposition opportunities. Universal structural truths independent of language or framework.
---

# General Decomposition Domain Knowledge

Universal structural concerns applicable to any codebase. These are truths about code organisation, not about any specific language or framework.

## DRY Violations

Flag logic blocks that appear more than once in the same file with only minor variation:
- **Duplicated blocks** — identical or near-identical code in two or more places. Recommend extraction to a named helper. Quote the repeated logic and name the proposed function.
- **Semantic inversions** — method pairs whose bodies are structurally identical but differ only in a scalar, sign, direction, or enum value (e.g., `GoBack()` / `GoForward()` differing only in `+1` / `-1`). Recommend merging into a single parameterised method.

## Hand-Rolled Algorithms

Flag manual loops that replicate well-known library functions. Name the specific replacement and cite the header or module.

## Comments as Decomposition Signals

- **A conditional block with an explanatory comment is a helper function the implementer overlooked.** If code needs a comment to explain what a branch does, that branch should be a named function.
- **Comments in headers can be important.** Design-intent comments, API contracts, and summary docs are legitimate.
- **Comments in implementation files explaining *what* code does (not *why*) are a smell.** The abstraction level is wrong.
- **"Section header" comments** (e.g., `// --- Handle tile remapping ---`) are almost always responsibility group boundaries. The implementer identified the seam but didn't act on it.

## Nesting Depth

- **Two levels is normal**: function scope + one conditional or loop.
- **Three levels is occasional**: function scope + outer loop + inner loop.
- **Four or more levels is a RED FLAG.** Report with specific remediation.

### Common causes

- **Pointer-checking chains** — cascading `if (Ptr) { if (Ptr->Inner) { ... }}`. Leaky abstraction boundaries. Fix: accessor or helper that encapsulates the traversal.
- **Missing helper functions** — deeply nested logic that could be named and extracted.
- **Inlined state machine transitions** — switch/case with nested conditionals per case. Extract each case body into a named handler.

### When nesting resists reduction

If you cannot decompose a deeply nested block — if every helper produces an incoherent signature requiring 6+ parameters — that signals **the design is missing an axis of abstraction**. A struct, a policy object, a visitor, or a different data representation would eliminate the nesting at the source. Report this as BLOCKING with your analysis of what abstraction is missing.

Decomposition is a **pressure cooker for auditing the design**. If it resists decomposition, the problem is upstream.
