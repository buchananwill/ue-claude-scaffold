---
name: general-decomposition
description: Use when reviewing any codebase for file bloat, excessive nesting, DRY violations, hand-rolled algorithms, and decomposition opportunities. Universal structural truths independent of language or framework.
---

# General Decomposition Domain Knowledge

Universal structural concerns applicable to any codebase. These are truths about code organisation, not about any specific language or framework.

## Responsibility Groups

A responsibility group is a cohesive unit of functionality that could live in its own file. Recognise these types:

- A class or struct definition with its own API surface
- A cluster of free functions that operate on the same data type or concept
- A self-contained algorithm (sort, search, transform) embedded in a larger file
- A block of type definitions (enums, type aliases, constants) serving a specific subsystem

Language- or framework-specific group types (e.g. UE UCLASS, USTRUCT, processor logic) are defined in companion domain skills.

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

## Decomposition Execution Rules

When proposing or executing a decomposition:

1. **Purely mechanical.** Extract, move, adjust includes. Do not redesign, optimise, or "improve" logic during extraction.
2. **Follow existing patterns.** If the codebase already has a convention for file splitting (e.g., one class per file, helpers in a `*Utils.h`), follow it.
3. **No renaming during extraction.** Rename in a separate, dedicated pass — not interleaved with structural moves.
4. **No logic changes.** The extracted code must behave identically. If you spot a bug, flag it separately.
5. **Preserve include hygiene.** After extraction, each file must include only what it directly uses.
6. **Preserve test structure.** If tests reference moved symbols, update the includes — do not reorganise test files as part of a decomposition.
