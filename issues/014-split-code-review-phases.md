---
title: "Split code review into separate phases with dedicated agents"
priority: high
reported-by: interactive-session
date: 2026-03-21
status: done
---

# Split code review into separate phases with dedicated agents

## Problem

Critical style and safety issues are getting through review. The single reviewer agent receives
the full specification, style rules, and changed files in one pass. The context window is too large
for the reviewer to fully parse all requirements — it's spreading attention across correctness,
safety, style, and spec compliance simultaneously, and dropping things.

## Observed misses

- Raw string literals duplicated across multiple files instead of a shared constant
- Immediately invoked lambda expressions (almost always the wrong tool in UE C++)
- Pointer lifecycle violations
- Style violations that the `ue-cpp-style` skill explicitly covers

## Proposed design: review phases

Split code review into multiple focused passes, each handled by a dedicated agent (or the same
agent with a tightly scoped prompt):

1. **Style review** — purely mechanical: east-const, braces, captures, IWYU, naming, symbol
   declarations. Smallest context needed.
2. **Safety review** — pointer lifecycles, dangling references, GC interactions, thread safety,
   MoveTemp correctness. Needs the changed files + their headers.
3. **Correctness review** — logic errors, spec compliance, invariant preservation, Mass ECS
   correctness. Needs the specification + changed files + usage context.

Each phase is pass/fail independently. The orchestrator runs them in sequence (or parallel if
they don't depend on each other's fixes).

## Avenue to explore: hook-based linting

Some issues are detectable mechanically without an LLM:

- **Duplicate string literals** — raw strings appearing in multiple files that should be a constant
- **Immediately invoked lambdas** — `[&]() { ... }()` pattern detection via regex
- **Pointer lifecycle** — `TObjectPtr<>` usage enforcement, raw pointer return from functions
  that create UObjects, `TSharedRef` special handling (cannot be null, must not be null-checked,
  construction requires valid object — agents frequently misuse it like `TSharedPtr`)
- **East-const violations** — `const T&` instead of `T const&`

These could run as a PreToolUse or PostToolUse hook on the build step, or as a standalone linting
pass. Mechanical checks free up the LLM reviewer to focus on things only an LLM can catch
(logic errors, spec compliance, architectural concerns).

## Additional Tier 1 lint rules (always wrong, no exceptions)

- **`new` keyword** — raw `new` is never correct in UE (2026). `NewObject` for GC objects,
  `MakeShared`/`MakeUnique` for everything else. Regex: `new ` followed by a type name, excluding
  `NewObject`, `MakeShared`, `MakeUnique`, `CreateDefaultSubobject`, placement new.

## Broader observation: task size vs. nuance

The implementer is struggling to integrate large tasks with complex style/safety rules in a single
pass. The orchestrator is YOLO-ing phases as one-shot delegations, and the implementer can't hold
(large_task + complex_nuance_ruleset) in working memory simultaneously. The code comes back
structurally correct but riddled with style and safety violations.

This is a Swiss cheese problem — no single layer catches everything. The fix is more layers with
smaller holes:
- **Smaller phases** — break work into units the implementer can fully hold in context
- **Mechanical linting** — catches the patterns that are always wrong, before the LLM reviewer
  even sees the code
- **Focused review agents** — each reviewer has a narrow mandate and short context
- **Per-phase enforcement** (issue #013) — no multi-phase bundling, so each unit stays small

## Scope

- Define 2-3 review sub-agents with tightly scoped prompts
- Update the orchestrator's phase execution protocol to run review phases in sequence
- Build a lint script/hook for Tier 1 patterns (IILE, raw new, TSharedRef misuse, east-const)
- Investigate Tier 2 heuristic patterns (raw pointer lifecycle, lambda captures)
- Feed lint output into the build result so agents see it alongside compiler output
- Measure: are fewer issues missed per phase with focused reviewers?
