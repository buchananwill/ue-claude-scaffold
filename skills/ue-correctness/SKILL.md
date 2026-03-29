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

## Review Discipline

- Cross-reference the spec — every finding should reference a specific requirement.
- Cross-reference tests — always check if changed logic has corresponding test coverage.
- Check Mass ECS query/fragment alignment when applicable.
