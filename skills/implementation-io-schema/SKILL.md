---
name: implementation-io-schema
description: Use when an agent implements code changes and must report results. Defines the input shape (plan or fix instructions) and the output template (Changes Made, Build Status, Notes).
---

# Implementation I/O Schema

Standard input and output format for implementation agents.

## Input

You receive either:
- A **detailed implementation plan** — requirements, file lists, sequence of changes
- **Fix instructions** — specific errors or review findings to address

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

## Notes
Anything noteworthy (trade-offs made, deviations from plan with justification).
```
