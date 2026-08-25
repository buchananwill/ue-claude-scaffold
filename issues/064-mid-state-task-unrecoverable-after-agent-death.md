---
title: "A task in FSM mid-state whose agent died is unrecoverable via the API"
priority: high
reported-by: interactive-session
date: 2026-08-13
---

# A task in FSM mid-state whose agent died is unrecoverable via the API

Task 218 (piste-perfect) was claimed and in `engineering` when its container was stopped and the
agent deregistered (`DELETE /agents/agent-1` → ok). The row is now permanently stuck:

- `DELETE /tasks/218` → 409 "cannot delete a task that is claimed or in progress"
- `POST /tasks/218/reset` → 409 "task can only be reset when complete, failed, or cycle"
- `POST /tasks/218/release` → 409 "task not in claimed status — FSM mid-state … stays attached to
  the claiming agent" (an agent that no longer exists)
- `PATCH /tasks/218` (to empty its `files` and defang ownership) → 409 "task can only be edited
  when pending"

Every recovery verb refuses for a different reason, and their union covers all states except the
one the row is in. Related prior reports: 008 (deregister does not stop container), 010
(stale-lock sweeper missed dead agent), 005 (arbitrating task uncancellable) — this is the same
family: **liveness of the claiming agent is never consulted**.

Suggested fix: any mutation verb (release at minimum) should succeed when the claiming agent's
registration is deleted or its heartbeat is stale; alternatively a sweeper that fails-over
mid-state tasks of dead agents to `failed` (making them resettable/deletable).

Open question this incident needs answered: does file-ownership scheduling consult dead agents'
claimed rows? Task 220 duplicates 218's `files`; if ownership blocks, the queue is wedged until
manual DB surgery or a server restart.

## Addendum (same day): mid-state rows REBIND to a same-name relaunch

After deregistering agent-1 and relaunching `--fresh --pump` for a replacement task, the new container re-registered under the same name and the server re-attached the zombie mid-state task to it — the pump resumed task 218 (posting 'Beginning revision cycle 2') instead of claiming the pending replacement. Deregistration therefore neither releases nor quarantines mid-state work; the row survives and captures the next same-name agent. Also noteworthy: the agent then recovered the orphaned pre-reset commits from dangling git objects and began re-applying them onto its new branch — resourceful, but it means a stale run's work can resurrect through a name collision, which strengthens the case for reset/failover semantics that actually sever the row from dead agents.
