---
title: "Reviewer fanout is silent on the message board during spawn"
priority: medium
reported-by: interactive-session
date: 2026-05-12
status: open
---

# Reviewer fanout is silent on the message board during spawn

## Problem

When the FSM transitions a task to `reviewing`, the reviewer-fanout dispatches
two or more reviewer subprocesses in parallel. Each reviewer is an Opus
session that reads the changed files, deliberates, and POSTs its verdict to
`/tasks/:id/reviews`. A single reviewer commonly takes 5–15 minutes; with
parallel execution and Anthropic-side rate limit contention, the wall-clock
window between "fanout dispatched" and "all verdicts posted" is regularly
20+ minutes.

During that window the operator sees nothing on the message board or the
dashboard chat. The container's docker log shows a single line
(`reviewer-fanout: spawning roles: <list>`) and then goes quiet until the
fanout exits. The dashboard task status stays at `reviewing`. The operator
cannot tell — from the surfaces designed for live observability — whether the
reviewers are actively working, have hung on a tool call, have hit auth
trouble, or have silently crashed.

The engineer role has no such gap. Its `message-board-protocol` skill
mandates a "smoke test" startup post (`[IMPLEMENTER] Agent online. Beginning
work.`) and follow-on status updates during work, so the operator watches the
engineer phase in near-real-time on the message board.

## Why it is happening

The reviewer subprocesses are spawned with stdout/stderr redirected to
per-role tmpfiles under `/workspace/.scratch/reviews/<task-id>/cycle-<N>/`
and are not loaded with the `message-board-protocol` skill in their composed
prompt. The reviewer agent definitions (e.g. `container-safety-reviewer-ue`,
`container-reviewer-ue`, `container-decomposition-reviewer-ue`) compose
review-focused skills only; nothing in their pipeline tells them to announce
themselves on the general channel.

The reviewer-fanout dispatcher itself does not post on the reviewers' behalf
either — it manages FSM transitions (`built → reviewing` entry, per-role
verdict merges, final `complete`/`revising`) but stays silent on the message
board between those transitions.

## Required behavior

- Each reviewer session must post a smoke-test message to the message board
  (general channel) within seconds of starting, naming its role so the
  operator sees `[REVIEWER:safety] Agent online`, `[REVIEWER:correctness]
  Agent online`, etc. The message must arrive before the reviewer begins its
  long read-and-deliberate pass, so a hung or auth-broken reviewer is
  distinguishable on the operator surfaces from a busy one.

- Each reviewer must post a final summary message before it exits, naming
  its verdict (`approve` / `request_changes` / `out_of_scope`) and a one-
  sentence rationale. The operator should not need to read the per-role
  `.md` file or query the dashboard to know which reviewer landed where.

- If a reviewer encounters a tool-call error, auth failure, or any other
  unexpected condition that would otherwise cause silent termination, it
  must surface the failure on the message board before exiting non-zero, so
  the reviewer-fanout retry budget consumption is operator-visible.

- The operator must not have to `docker exec` into the container or read
  per-role tmpfiles to confirm reviewers are alive. The message board is
  the single live-observability surface for FSM execution.

## Sequencing notes

- The smoke-test obligation applies to every FSM role session that runs a
  long pass, not just reviewers. The arbitrator path has the same shape and
  should adopt the same posture in the same pass.

- The engineer's `message-board-protocol` skill is the existing template;
  whatever discipline travels to the reviewers should ride the same skill
  surface rather than per-agent prose.
