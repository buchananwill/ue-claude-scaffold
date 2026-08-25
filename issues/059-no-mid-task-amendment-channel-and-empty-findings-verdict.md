---
title: "No reliable mid-task spec-amendment channel; reviewer verdict with empty findings"
priority: medium
reported-by: interactive-session
date: 2026-07-23
---

# No reliable mid-task spec-amendment channel; reviewer verdict with empty findings

Two related defects observed on piste-perfect task 201 (and the first also on task 200).

## 1. Operator cannot amend a claimed task's spec

When a plan revision lands after a task is claimed, there is no route that reliably reaches
the running FSM:

- `PATCH /tasks/:id` returns `409 task can only be edited when pending` — so file-ownership
  and spec-reference fixes are impossible mid-flight (task 200 needed an ownership expansion;
  task 201 needed a spec-revision notice because the bare-repo sync predated the revision
  commit).
- Operator notes posted to `general` (messages 31878, 31885 — the second addressed to both
  the implementer and the reviewers, with a concrete required delta) were not acted on across
  two full engineering cycles. In-flight role agents evidently do not (re)read the channel
  once running, and reviewer prompts do not incorporate operator notes.

Effect: the only workable correction path is letting the task finish against a stale spec and
patching host-side afterwards, which defeats the review cycle for exactly the changes the
operator most cares about.

Suggested directions (any one would do): allow `PATCH /tasks/:id` for a whitelisted field set
(`files`, advisory `addendum` text) while claimed, with the FSM injecting the addendum into
the next role-agent prompt; or feed unclaimed `general` notes tagged to the task id into the
implementer's revision-cycle prompt; or expose a `POST /tasks/:id/addendum` that lands in the
same slot the arbitrator's `arbitrationAddendumPath` uses.

## 2. Reviewer verdict recorded with empty findings

Task 201, review run 1021 (style-decomp, cycle 2): verdict `request_changes` was recorded,
but `rawMarkdown` was a placeholder and the findings list was empty server-side. The
implementer could not retrieve any actionable content and had to self-audit instead
(flagged in its debrief-1004). A `request_changes` verdict with zero findings should be
rejected or retried at the server boundary rather than persisted — it consumes a review
cycle from the task's budget while carrying no information.

## Recurrence — task 209 (2026-07-31)

Defect 1 reproduced with materially higher stakes than on tasks 200/201.

Task 209's implementer reported 22 full-suite failures and attributed all of them to
pre-existing content state, while explicitly flagging that attribution as "the weakest
evidence in this debrief" because the container is pinned to one branch and cannot check out
the seed to A/B it. That is a correct account of a real container limitation, and it is
precisely the gap an operator can close.

The host session ran the missing A/B at the pre-change seed (1504 total, 1499 passed, 5
failed) and found only 5 of the 22 reproduce, with roughly 17 — several in areas the diff
touches — passing pre-change. A follow-up check established that the two data-table assets
the debrief blamed are absent from *both* checkouts, and that the `Missing RowStruct` error
does not appear anywhere in the pre-change log, so "checkout asset state" does not explain
the difference.

Both findings were posted to `general` (messages 32215 and 32216) because no other route
exists. Per this issue, in-flight role agents do not re-read the channel, so the reviewers
assessing cycle 1 are evaluating the change without evidence that directly contradicts a
load-bearing claim in the material they were given.

This is the shape of the problem worth fixing: the operator is the only actor in the system
that *can* run a same-environment A/B against the seed, and there is no way to hand the result
to the review cycle that consumes it. The `POST /tasks/:id/addendum` direction already
suggested above would have been sufficient here.
