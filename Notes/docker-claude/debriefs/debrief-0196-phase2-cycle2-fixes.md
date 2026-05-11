# Debrief 0196 — Phase 2 cycle 2: address review findings

## Task Summary

Cycle 2 of Phase 2 (server FSM transition endpoint). Two reviewers landed
REQUEST CHANGES against commit `896e501`. The brief enumerated:

- **Safety B1 / Correctness W4** (BLOCKING): `latestReviewPath` was required
  unconditionally on `target === 'revising'`, but the plan only mandates it on
  the `reviewing → revising` edge. The `arbitrating → revising` edge (Phase 7
  arbitrator ruling="rule") must succeed without it.
- **Correctness B1** (BLOCKING): the `reviewing → revising` non-reroute path
  must also verify that the merged `reviewerVerdicts` contains at least one
  `request_changes` value. The plan transition table is "any verdict ==
  request_changes; reviewCycleCount++ at this transition".
- **Correctness B2** (BLOCKING): `'arbitrating'` must be removed from the
  `reviewing` entry in the FSM transition table. The plan does NOT list a
  client-driven `reviewing → arbitrating` edge — that route exists only as a
  server-side reroute on what would be `reviewing → revising` when the cycle
  budget is exhausted. Allowing direct posts bypasses the central enforcement.
- **Safety W1** (WARNING): cap `reviewerRole` length and charset on the
  `reviewing → reviewing` self-loop.
- **Safety W2** (WARNING): cap `commitSha` (≤128) and `latestReviewPath`
  (≤4096) lengths.
- **Correctness W3** (WARNING): add tests covering the new behaviours and
  caps.

`engineering → arbitrating` (with `trigger='reviewer_contradiction'`) remains
the legitimate contradiction escape hatch and was untouched.

## Changes Made

- `server/src/routes/tasks-lifecycle.ts`
  - Removed `'arbitrating'` from the `reviewing` entry in the FSM transition
    table. The reroute path inside the `target === 'revising'` branch is
    untouched and still rewrites `update.status = 'arbitrating'`
    server-side, so the cycle-budget reroute behaviour is preserved.
  - Added module-level constants for length / charset caps:
    `REVIEWER_ROLE_RE = /^[A-Za-z0-9_-]+$/` (consistent with
    `branch-naming.ts`'s `AGENT_NAME_RE`), `REVIEWER_ROLE_MAX = 64`,
    `COMMIT_SHA_MAX = 128`, `LATEST_REVIEW_PATH_MAX = 4096`.
  - `target === 'built'`: enforce `commitSha.length ≤ 128` (400 on overflow).
  - `target === 'reviewing'` self-loop: validate `reviewerRole` against the
    regex and length cap (400 on either failure) before merging into
    `reviewerVerdicts`.
  - `target === 'revising'`: restructured into two distinct branches by the
    `current` state.
    - `current === 'reviewing'`:
      - Requires `latestReviewPath` (presence + type + length cap).
      - Verdict gate: rejects with 409 if no value in `reviewerVerdicts`
        equals `'request_changes'`. Body names current and target states and
        explains "no reviewer has posted request_changes".
      - Cycle-budget arithmetic runs *after* the verdict gate. On the reroute
        path, `latestReviewPath` is NOT written (the task is entering
        arbitrating, not revising). The non-reroute path writes
        `latestReviewPath` and increments `reviewCycleCount`.
    - `current === 'arbitrating'`: `latestReviewPath` is OPTIONAL. If
      supplied, validated (type + length) and written; otherwise left
      untouched. `arbitrationPendingTrigger` is always cleared to NULL.
  - `target === 'arbitrating'`: updated the comment to reflect that the only
    legal client-driven source is `engineering` — the FSM table no longer
    permits a direct `reviewing → arbitrating` post, so the route handler
    will never be reached from a `reviewing` row (it's blocked by the FSM
    table guard above).

- `server/src/routes/tasks-lifecycle.test.ts`
  - Added `seedVerdict()` helper that writes a single-key `reviewerVerdicts`
    object directly via SQL (jsonb cast on a JSON-stringified object).
  - Updated three existing tests that drive `reviewing → revising` to first
    seed a `request_changes` verdict so the new verdict gate is satisfied:
    - "reviewing → revising reroutes to arbitrating when budget exhausted"
    - "reviewing → revising under budget proceeds to revising and increments count"
    - "revising → engineering succeeds"
    - "cycle-budget reroute returns 409 when an arbitration row already exists for the same trigger"
  - Added new tests under "12b. behaviour-fidelity guards" / "12c. length /
    charset caps":
    - `reviewing → revising returns 409 when no reviewer has posted request_changes`
    - `reviewing → arbitrating direct posting returns 409` (B2 consequence)
    - `arbitrating → revising succeeds without latestReviewPath` (B1
      consequence)
    - `engineering → built returns 400 when commitSha exceeds length cap`
    - `reviewing → revising returns 400 when latestReviewPath exceeds length cap`
    - `reviewing → reviewing returns 400 when reviewerRole contains illegal characters`
    - `reviewing → reviewing returns 400 when reviewerRole exceeds length cap`

## Design Decisions

- **Charset regex pick.** The plan said "consistent with existing identifier
  conventions in the server" and pointed at `agents.ts`/`branch-naming.ts`.
  `branch-naming.ts` defines `AGENT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/`. I
  matched that exactly: `/^[A-Za-z0-9_-]+$/` plus the explicit length cap of
  64. Reviewer roles in the wild are `safety`, `correctness`, `style` etc. —
  this regex covers everything actually used and rejects whitespace and
  punctuation that could leak into jsonb keys.
- **Verdict gate placement.** The brief says "this check applies before the
  cycle-budget arithmetic". I placed it after `latestReviewPath` validation
  (which is purely a 400-on-bad-input check) but before the
  `nextCount`/`reviewCycleBudget` comparison. Result: a `reviewing → revising`
  call without a `request_changes` verdict is rejected with 409 regardless of
  cycle count, preventing the reroute path from firing on incoherent state.
- **`latestReviewPath` write semantics on cycle-budget reroute.** The brief
  says "do not write it" on the reroute path. The previous code wrote it
  early and then `delete update.latestReviewPath` on the reroute branch — I
  inverted the order so the column is only written on the non-reroute path.
  Equivalent behaviour, fewer footguns.
- **Test seed approach.** The seed-verdict helper writes via SQL rather than
  via `transition()` because the `reviewing → reviewing` self-loop is the
  only client-facing way to write verdicts and it would itself need to
  succeed first; simulating the engineer's read-then-revise decision is more
  direct via SQL. This mirrors the existing pattern of using SQL to set
  `review_cycle_count`.
- **Did NOT touch** `query-helpers.ts`, `tasks-claim.ts`, `task-deps.ts`,
  `tasks-replan.ts`, `tasks-core.ts`. Per the brief, Correctness W1 and
  Correctness W2 are explicitly deferred to Phase 9, which is the hard
  cutover for `ACTIVE_STATUSES` / `TERMINAL_STATUSES` and the surrounding
  status-string sweep. Phase 2's contract is the transition endpoint
  contract and its surrounding handlers — touching the broader sweep now
  would expand scope and step on Phase 9's plan. Recording this decision
  here as the brief instructed.

## Build & Test Results

Pending — about to run `npm run build` and `npm test` in `server/`.

## Open Questions / Risks

- The "arbitrating → revising succeeds without latestReviewPath" test
  exercises the new optional path. The pre-existing
  "arbitrating → revising succeeds and clears the pending trigger" test still
  passes `latestReviewPath` and asserts the column is written; that exercises
  the supplied-but-optional path. Both cover the contract.
- Removing `'arbitrating'` from the `reviewing` FSM entry means the only path
  into arbitrating from a reviewing-state task is the server-side reroute.
  This is now structurally enforced by the FSM table, not just by validation.
  Anyone who genuinely needs to escalate a reviewing-state task without
  hitting the budget would have to do so via the engineering edge (after
  failing the build, etc.) — which is exactly what the plan intends.

## Suggested Follow-ups

- Phase 9 sweep of legacy status strings (`completed`, `in_progress` etc.)
  in `query-helpers.ts`, `tasks-claim.ts`, `task-deps.ts`,
  `tasks-replan.ts`, `tasks-core.ts` — already planned, recorded here as a
  pointer back to the deferred items.
