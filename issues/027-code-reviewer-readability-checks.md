---
title: "Code quality reviewer misses readability and DRY violations"
priority: high
reported-by: interactive-session
date: 2026-03-23
---

## Problem

The container workflow's code quality reviewer (`ue-code-reviewer` agent) currently focuses on
correctness, memory safety, thread safety, Mass ECS correctness, and invariant preservation. It
does not check for readability, DRY violations, or structural issues that affect long-term
maintainability. A file (`PageRouter.cpp`) passed through container work with all of the following
unaddressed:

1. **Duplicated logic** — identical factory-slot allocation appeared in two branches of the same
   method. Identical factory-slot release appeared in two branches of another. Neither was
   extracted.

2. **Semantic inversions not merged** — `GoBack()` and `GoForward()` were structurally identical
   methods differing only in a `+1`/`-1` delta. The reviewer should flag pairs of methods whose
   bodies are token-identical modulo a scalar/directional parameter, and recommend merging into a
   single parameterised helper.

3. **Magic strings as type discriminators** — `"/*"` was used as an inline string literal to
   distinguish prefix routes from exact routes in two separate methods. The reviewer should flag
   string literals that appear more than once and carry semantic meaning beyond their character
   content.

4. **Comments narrating code blocks** — comments like `// Truncate forward history beyond the
   cursor` and `// Insert maintaining descending Stem.Len() order` described scope blocks that
   should have been extracted to named helpers. The comment is a signal that the block has a
   distinct responsibility; a named function makes the comment redundant and carries executive
   power.

5. **Hand-rolled algorithms with UE/std equivalents** — a manual `while` loop for sorted insertion
   where `Algo::LowerBoundBy` exists. The reviewer should flag hand-rolled loops that replicate
   well-known library algorithms.

6. **Inconsistent type choices in the same header** — `TFunction` for one typedef, `std::function`
   for another, in the same file. The reviewer should flag mixed usage when the project has a
   stated preference.

7. **Implicit reliance on `FName` case semantics** — exact route matching silently depends on
   `FName` being case-insensitive, while sibling prefix-matching code uses an explicit
   `ESearchCase::IgnoreCase` parameter. The reviewer should flag implicit case behaviour when
   neighbouring code is explicit.

8. **Dead commented-out code** — `// return nullptr;` left on a line after a live `return`
   statement.

## Why this matters

These are not style nitpicks. Duplicated logic is a bug vector — one copy gets fixed, the other
doesn't. Semantic inversions that aren't merged mean the same structural bug can be introduced
twice. Magic strings are fragile. Comments that narrate blocks go stale and mislead. These issues
compound over time and are far cheaper to catch during review than to excavate later.

## Addressing the "function call overhead" concern

A common reason reviewers stay silent about extraction is an implicit belief that function calls
have runtime cost. In this codebase:

- **Unity builds** — Unreal Engine amalgamates related TUs. The compiler sees callers and callees
  in the same compilation unit. Small helpers are inlined automatically.
- **Modern compilers** — MSVC, Clang, and GCC have been excellent at inlining for over a decade.
  A 5-line private method in the same TU has zero call overhead in practice.
- **If profiling disagrees** — adding `FORCEINLINE` to a hot helper is trivial. The default should
  be maximum readability; inlining is a targeted optimisation applied after measurement, not a
  pre-emptive constraint on code structure.

The reviewer's prompt should explicitly state that extraction is free and encouraged, to prevent
the agent from self-censoring extraction suggestions out of misplaced performance concern.

## Requested changes

Add the following checks to the `ue-code-reviewer` agent's review protocol:

1. **DRY** — Flag logic blocks that appear more than once in the same file with only minor
   variation. Recommend extraction to a named helper.
2. **Semantic inversions** — Flag method pairs whose bodies differ only in a scalar, sign, or
   enum value. Recommend merging into a single parameterised method.
3. **Magic literals** — Flag string or numeric literals that appear more than once and carry
   implicit semantic meaning. Recommend hoisting to a named constant.
4. **Comment-as-name** — Flag comments that describe what a scope block does when the block could
   be extracted to a function whose name replaces the comment.
5. **Hand-rolled algorithms** — Flag manual loops that replicate `Algo::*`, `std::*`, or
   `TArray::*` library functions.
6. **Type consistency** — Flag mixed usage of equivalent types (`TFunction`/`std::function`,
   `TArray`/`std::vector`, etc.) when the project has a stated preference.
7. **Implicit vs explicit semantics** — Flag code that relies on implicit behaviour (e.g. `FName`
   case insensitivity) when neighbouring code in the same file is explicit about the same concern.
8. **Dead code** — Flag commented-out code. It belongs in version control history, not in the
   source file.
9. **Extraction is free** — The reviewer must not withhold extraction suggestions due to
   perceived function-call overhead. State in the prompt that unity builds and modern compiler
   inlining make small same-TU helpers zero-cost, and that readability is the default priority.
