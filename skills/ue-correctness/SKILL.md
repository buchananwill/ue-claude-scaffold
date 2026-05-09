---
name: ue-correctness
description: Use when reviewing Unreal Engine C++ code for UE-specific correctness concerns — Mass ECS query/fragment alignment, UE invariant preservation, and UE-specific semantic traps. Compose with general-correctness for universal logic checks.
---

# UE Correctness Domain Knowledge

UE-specific correctness concerns that go beyond general logic checking. These are truths about Unreal Engine's frameworks and idioms.

## Mass ECS Correctness

- Fragment access declarations (`FMassEntityQuery`) must match actual fragment usage in `Execute()`
- Processor dependencies must be complete — missing `ExecuteAfter`/`ExecuteBefore`
- Entity handle validity checks before dereferencing
- Archetype changes invalidating cached entity references
- Processor registration and initialization ordering

## Implicit vs Explicit UE Semantics

Flag code that relies on implicit UE behaviour when neighbouring code is explicit about the same concern:
- `FName` comparison is silently case-insensitive — if a sibling method uses `ESearchCase::IgnoreCase` explicitly, the implicit path is a latent bug for future maintainers
- Default parameter values assumed but not stated, while nearby call sites spell them out
- Container ordering assumed stable when a sibling function explicitly sorts

The implicit path may be correct today, but a reader who sees the explicit version will assume the implicit one is different. Make the behaviour explicit to match its neighbours.

## Production Code Is for Production Concerns

A production code file (a `.h` or `.cpp` outside `/Private/Tests/`, `*.spec.cpp`, or other test-only directories) must read as a description of what the system does, not how it is exercised. **Someone reading a production code file must not be able to discern anything about how tests are conducted. That is noise.** Reading the production code must only involve understanding production concerns.

Any of the following in a production code file is **BLOCKING**:

- A function, member, or macro whose name contains `ForTesting`, `_ForTest`, `TestSeam`, `TestOnly`, `TestHook`, or any equivalent.
- A function whose only documented purpose is to be called from tests (Doxygen comments that begin "Test seam:", "Used by tests to…", "Tier N specs use this to…", etc.).
- A `friend` declaration against a test fixture whose only purpose is to expose private state to tests.
- A public accessor whose comment explains the **test scenario** that needs it rather than the **production caller** that needs it.
- **Any occurrence of `WITH_DEV_AUTOMATION_TESTS`** in a file outside `/Private/Tests/`. This macro gates test infrastructure; it must never appear in production code, full stop. A file outside `/Private/Tests/` that contains this macro is suspect as a whole — investigate the entire file, not just the gated block, since the seam is rarely isolated.

Cite the exact symbol or comment as evidence. The fix is always to remove the seam from production and rewrite the test against the production surface — never to accept a test-only seam in production.

### What Is Not a Test Seam

The following gates run code in **production modes** of the engine, not test modes, and are **not** covered by this rule:

- `#if WITH_EDITOR` — gates code for the editor build configuration. Editor-gated members, callbacks, and overrides (`PostEditChangeProperty`, `CanEditChange`, editor-only validation) are legitimate production code.
- `#if WITH_EDITORONLY_DATA` — gates editor-only data fields. Same rationale: the editor is a production mode of the engine.

## Review Discipline

- Cross-reference the spec — every finding should reference a specific requirement.
- Cross-reference tests — always check if changed logic has corresponding test coverage.
- Check Mass ECS query/fragment alignment when applicable.
