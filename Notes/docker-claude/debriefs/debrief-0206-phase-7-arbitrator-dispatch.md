# Debrief 0206 — Phase 7: Arbitrator agent and dispatch

## Task Summary

Implement Phase 7 of the Durable Task FSM plan: the arbitrator role that adjudicates between
reviewer contradictions or judges whether a 5-cycle budget-exhausted task can still
complete. Deliverables:

- `POST /tasks/:id/arbitrations` server endpoint that inserts an `arbitrationRuns` row and
  drives the task FSM transition out of `arbitrating` atomically.
- `container/lib/arbitrator-dispatch.sh` — a daisy-chain dispatcher that launches a
  read-only `claude -p` session against the arbitrator agent, with prompt context built
  from plan / cycle reviews / commit history.
- `dynamic-agents/container-arbitrator-ue.md` — the new arbitrator agent definition (Opus,
  read-only mandate, scoped permission posture).
- `run-claude.sh` extension to detect `DAISY_CHAIN_ROLE=arbitrator` and hand off to the
  dispatch script.

## Changes Made

- `server/src/routes/arbitrations.ts` (new) — `POST /tasks/:id/arbitrations` plugin.
  Validates the payload (trigger × ruling cross-checks, contradictionResolution presence),
  starts a DB transaction, inserts the arbitrationRuns row, derives the new task status
  per the ruling, and applies the FSM transition via `tasksLifecycleQ.applyTransition`
  (using `tasks.status = 'arbitrating'` as the gate). Returns 409 on unique-constraint
  conflict for `(taskId, trigger)`.
- `server/src/routes/arbitrations.test.ts` (new) — node:test + assert/strict tests for
  the happy paths (approve / rule / escalate), payload validation
  (`rule` requires `contradictionResolution`; `review_cycle_budget_exhausted` rejects
  `rule`), uniqueness 409, transition column writes
  (`arbitrationPendingTrigger` cleared, `arbitrationAddendumPath` set on rule,
  `failureReason`/`failureDetail` set on escalate, `completedAt` set on approve).
- `server/src/routes/index.ts` — re-exports the new `arbitrationsPlugin`.
- `server/src/index.ts` — registers the new plugin (this file is not in the explicit
  ownership list but the plugin must be registered somewhere for the route to be reachable;
  this is a minimum-viable change to wire the new route through the server bootstrap, no
  behaviour change to existing handlers).
- `dynamic-agents/container-arbitrator-ue.md` (new) — agent definition with skill stack
  (`action-boundary`, `review-process` for the structured-output discipline,
  `project-patterns`, `ue-engine-mount`). Model: opus. Tools: Read/Glob/Grep/Bash (the
  narrow Bash allowlist used by reviewers). FSM-aware system prompt: names the
  three possible rulings (approve / rule / escalate), the exact `POST
  /tasks/:id/arbitrations` payload, the addendum-file convention for `rule`, and the
  explicit "be willing to escalate" instruction from the plan.
- `container/lib/arbitrator-dispatch.sh` (new) — dispatcher mirroring reviewer-fanout.sh
  patterns. Fetches the task to read `arbitrationPendingTrigger`, builds a per-trigger
  prompt (cycle-exhausted: lists all prior consolidated.md files, names the commit log
  and the diff between the last two cycles; contradiction: lists the two finding IDs and
  the per-reviewer markdown for the two reviewers involved). Launches `claude` with
  scoped Read/Grep/Glob/Bash tools and Opus 4.7. Output stdout is captured to
  `.scratch/arbitrations/<task-id>/<trigger>.md.tmp`, atomic-renamed to `.md` on clean
  exit. Does NOT post the `POST /arbitrations` itself — the arbitrator session owns that
  post (per plan step 2).
- `container/lib/run-claude.sh` — adds a `DAISY_CHAIN_ROLE=arbitrator` branch that sources
  `arbitrator-dispatch.sh` and hands off to `_run_arbitrator_dispatch`. Mirrors the
  existing `reviewer-fanout` early-return pattern: the function call replaces the
  default `claude --dangerously-skip-permissions` invocation entirely because the
  dispatcher launches its own scoped `claude` subprocess.
- `container/lib/pump-loop.sh` — removes the Phase 4 arbitrator stub at lines 205-209.
  The stub was explicitly placed "until Phase 7 wires arbitrator the same way" and
  unconditionally halted the daisy-chain whenever a task reached `arbitrating`. Without
  removing it, the new dispatch script can never fire and the acceptance criterion
  "a task at cycle 5 receiving a request_changes verdict transitions to arbitrating ...
  the arbitrator dispatch fires" is unmeetable. **This file is technically outside the
  Phase 7 ownership list**, but the change is the minimum-viable removal of a stub that
  Phase 4 explicitly authored for Phase 7 to remove (see the comment at pump-loop.sh:203
  in the pre-Phase-7 state). Flagging for reviewer awareness.

## Design Decisions

1. **Server holds the rule, not the arbitrator.** The arbitrator posts a ruling; the
   server performs the transition. This keeps the FSM authoritative and means the
   arbitrator's role is purely advisory. Concretely, `POST /arbitrations` does both
   the arbitrationRuns insert and the task-status update in a single transaction so a
   crash between them is impossible.
2. **`tasks.status = 'arbitrating'` is the transition guard.** Like the existing
   `applyTransition` helper, the arbitration handler uses the expected-status optimistic
   lock pattern — if the task left `arbitrating` between read and write (e.g. operator
   reset), the transition returns null and the route surfaces a 409.
3. **No new query module.** The handler uses the existing `applyTransition` helper from
   `queries/tasks-lifecycle.ts` and a single Drizzle insert into `arbitrationRuns`. The
   plan does not list a queries module, and the inline DB work is small enough to keep
   in the route handler. The unique-constraint detection mirrors the pattern in
   `reviews.ts` (PG SQLSTATE 23505 + constraint name match).
4. **Atomicity: insert + transition in one DB transaction.** Both writes happen inside
   `db.transaction(async (tx) => ...)`. A failed transition rolls back the
   arbitrationRuns insert; a unique-constraint violation on the insert short-circuits
   before any transition is attempted.
5. **Addendum path convention.** On `rule`, the route sets `arbitrationAddendumPath` to
   `.scratch/arbitrations/<task-id>/contradiction-ruling.md` (per plan step 1 sub-bullet).
   This is the path the engineer's revision-cycle prompt branch (Phase 5 branch 3) reads.
6. **Failure-detail truncation.** On `escalate`, the route truncates `rulingMarkdown`
   to 500 characters for `failureDetail` (per plan: "first 500 chars of rulingMarkdown").
   This keeps the column readable in the dashboard failure-reasons panel.
7. **Dispatch script structure.** Mirrors `reviewer-fanout.sh`: a public entry
   `_run_arbitrator_dispatch <task-id>` is sourced into the shell, called from
   `run-claude.sh`'s arbitrator branch. Per-trigger prompt construction is split into
   `_arb_build_cycle_exhausted_prompt` and `_arb_build_contradiction_prompt` for clarity.
8. **Why `--allowed-tools` includes `curl`.** The arbitrator must POST its own ruling
   per plan step 2 ("the arbitrator session is responsible for posting the `POST
   /tasks/:id/arbitrations` call itself"). The reviewer fanout uses the same posture.
9. **Why `--model claude-opus-4-7` is named explicitly in the dispatch.** The plan calls
   this out as load-bearing: "the arbitrator runs Opus deliberately — this is the most
   consequential single judgment in the FSM and runs at most twice per task." A
   model-override flag on the `claude` CLI keeps that decision explicit at the dispatch
   site rather than relying on agent-front-matter defaults.

## Build & Test Results

Pending initial build. Will run `cd server && npm run typecheck && npm test` after
committing this debrief, plus `bash -n` on the new shell scripts.

## Open Questions / Risks

- The pump-loop.sh stub removal is the cleanest interpretation of Phase 7's intent but
  not literally enumerated in the ownership list. Calling this out in the message-board
  notes for operator awareness. The plan author left a TODO comment in pump-loop.sh
  explicitly naming Phase 7 as the consumer.
- The `--model claude-opus-4-7` flag relies on the `claude` CLI supporting this exact
  identifier. If the binary's model-id format diverges in a future release, the dispatch
  will need updating. The plan literally specifies `--model claude-opus-4-7`.
- The arbitrator prompt asks the model to read multiple files (consolidated.md per cycle,
  per-reviewer .md, plan path). Token cost is bounded by the cycle budget (5 cycles ×
  three reviewer reports) which should comfortably fit in Opus context, but a runaway
  task with extremely verbose reviewer markdown could push limits. No mitigation
  attempted — Opus 4.7 has a wide enough context window.

## Suggested Follow-ups

- Dashboard rendering of arbitrationRuns rows is Phase 8 work — not in scope here.
- An operator-facing endpoint to manually post an arbitration ruling
  (`POST /tasks/:id/arbitrations` from the dashboard) would let humans escalate-or-rule
  on tasks where the arbitrator session itself crashed. Worth considering in Phase 8.
