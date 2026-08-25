---
title: "POST /tasks/:id/reset keeps reviewCycleCount, silently shrinking the rerun's review budget"
priority: medium
reported-by: interactive-session
date: 2026-08-13
---

# `POST /tasks/:id/reset` keeps `reviewCycleCount`, silently shrinking the rerun's review budget

Resetting completed task 218 back to pending preserved `reviewCycleCount: 2`, so the rerun would
face arbitration after 3 cycles instead of its budgeted 5. The field is not PATCHable (`Unknown
fields: reviewCycleCount`), and delete-and-repost as a workaround races the pump's claim loop —
in this incident the pump claimed the reset row inside the seconds between reset and delete,
yielding a 409 plus a duplicate row that then had to be deleted.

Suggested fix: reset zeroes the per-run FSM state (`reviewCycleCount`, `reviewerVerdicts`,
`buildStatus`, `progressLog`) since a reset row is semantically a fresh run; alternatively make
the counters PATCHable on pending rows.
