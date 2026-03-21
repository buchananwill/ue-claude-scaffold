---
title: "Split code review into separate phases with dedicated agents"
priority: high
reported-by: interactive-session
date: 2026-03-21
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

## Scope

- Define 2-3 review sub-agents with tightly scoped prompts
- Update the orchestrator's phase execution protocol to run review phases in sequence
- Investigate which style/safety checks can be automated as hooks or scripts
- Measure: are fewer issues missed per phase with focused reviewers?
