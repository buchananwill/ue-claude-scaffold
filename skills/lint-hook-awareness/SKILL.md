---
name: lint-hook-awareness
description: Use for any agent that writes or reviews UE C++ code in the container environment. Lists which style rules are already enforced by the mechanical lint hook at write-time, so agents know what is auto-caught versus what requires manual attention.
---

# Lint Hook Awareness

A PreToolUse lint hook (`lint-cpp-diff.py`) runs automatically on every Edit and Write operation against `.h` and `.cpp` files. It catches violations mechanically — before the code is even committed.

## Rules Enforced by the Lint Hook

The following patterns are caught at write-time. **Do not re-report these** in code reviews unless the linter genuinely missed an instance:

- **East-const violations** — `const T&` flagged, should be `T const&`
- **Greedy lambda captures** — `[&]` and `[=]` flagged, should use explicit captures
- **Raw `new`** — flagged, should use `NewObject`, `MakeShared`, or `MakeUnique`
- **Multiple declarations on one line** — flagged
- **Uninitialised `TSharedRef` fields** — flagged
- **Immediately invoked lambda expressions (IILE)** — flagged, should extract to a named function or variable

## What the Lint Hook Cannot Catch

The linter is pattern-based and line-local. It cannot assess:

- Naming convention correctness (UE prefixes, PascalCase, Out-parameters)
- Include hygiene (IWYU, include order, transitive dependencies)
- Semantic type consistency (TFunction vs std::function mixed usage)
- Dead code or commented-out blocks
- UE macro specifier correctness (UPROPERTY categories, GENERATED_BODY presence)
- Structural or architectural concerns

These require manual review.
