---
title: "Batch task reset endpoint"
priority: medium
reported-by: interactive-session
date: 2026-03-25
---

# Batch task reset endpoint

## Problem

When an entire batch of tasks needs to be re-run (e.g. after discovering a build system bug that invalidated all results), the only option is to loop through `POST /tasks/:id/reset` one at a time. This is tedious for the operator and noisy in logs.

## Proposed design

Add `POST /tasks/reset-batch` accepting either an explicit list of IDs or a filter:

```json
// Explicit IDs
{ "ids": [63, 64, 65, 66, 67, 68, 69, 70, 71] }

// Range
{ "from": 63, "to": 81 }

// All completed tasks
{ "status": "completed" }
```

Returns `{ ok: true, count: N, ids: [...] }` matching the `integrate-batch` / `integrate-all` pattern.

The same validation that `POST /tasks/:id/reset` applies (status must be completed/failed/cycle, sourcePath must still exist) should apply per-task, with failures collected and returned rather than aborting the whole batch.

## Context

Triggered by a build system bug (false ~950ms successes due to UBT not seeing file changes) that required resetting 19 tasks and two agent branches.
