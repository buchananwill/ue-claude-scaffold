---
title: "No operator path to cancel/terminate a task stuck in arbitrating (FSM mid-state) after its agent is stopped"
priority: medium
reported-by: interactive-session
date: 2026-07-01
---

Task 180 (piste-perfect) escalated to `arbitrating` (reviewer_contradiction). After
`stop.sh --agent agent-1`, the claiming agent is gone but the task is wedged:

- `DELETE /tasks/180` -> 409 "cannot delete a task that is claimed or in progress — release it first"
- `POST /tasks/180/reset` -> 409 "task can only be reset when complete, failed, or cycle"
- `POST /tasks/180/release` -> 409 "task not in claimed status — FSM mid-state, terminal, and unknown tasks are not released"
- `POST /tasks/180/{fail,cancel,abort,unclaim}` -> 404 (no route)
- `PATCH /tasks/180 {status}` -> 400 (status not a mutable field)

Request: an operator escalation path to force-terminate an FSM mid-state task
(arbitrating/engineering) whose agent has been stopped — e.g. `POST /tasks/:id/abandon`
that moves it to `failed`, or auto-release of FSM mid-states on agent stop/timeout.
