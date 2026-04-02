---
name: tdd-implementation-io-schema
description: Use when an agent implements code via TDD and must report results. Defines the input shape (plan or fix instructions) and the output template (Changes Made, Build Status, Test Status, Notes).
axis: schema
---

# TDD Implementation I/O Schema

Standard input and output format for TDD implementation agents.

## Input

You receive either:
- A **detailed implementation plan** -- requirements, file lists, sequence of changes
- **Fix instructions** -- specific errors or review findings to address

## Output

```
## Changes Made
For each file touched:
- **File**: path
- **Action**: created / modified / deleted
- **What changed**: brief description

## Build Status
- **Result**: SUCCESS / FAILURE
- **Command**: <build command used>
- **Errors** (if failed): <relevant error output>

## Test Status
- **Result**: PASS / FAIL / SKIP (reason)
- **Command**: <test command used>
- **Tests**: N passed, N failed
- **Failures** (if any): <failing test names and assertion errors>

## Notes
Anything noteworthy (trade-offs made, deviations from plan with justification).
```
