# Debrief 0195 — Phase 2: Server FSM transition endpoint

## Task Summary

Implement Phase 2 of the durable-task-FSM-and-parallel-role-sessions plan:

- Delete the legacy `POST /tasks/:id/complete` and `POST /tasks/:id/fail`
  routes and their query helpers (`tasksLifecycleQ.complete`,
  `tasksLifecycleQ.fail`).
- Update the surviving `reset` and `integrate*` endpoints/queries to use the
  new `'complete'` enum value instead of the deprecated `'completed'`.
- Add `POST /tasks/:id/transition` with the full FSM transition table and
  per-payload field updates (build status, commit sha, latest review path,
  per-reviewer verdict merge / reset, arbitration handshake, failure
  metadata), cycle-budget reroute, contradiction routing, and arbitration
  uniqueness guard.
- Validate the request: 400 on missing `to` / unknown `to` / missing
  payload required for the transition / missing `X-Project-Id` header; 404
  on unknown task; 409 on illegal FSM edge or arbitration uniqueness
  collision.
- Backfill route tests covering every acceptance criterion in the plan.

Plan file: `plans/durable-task-fsm-and-parallel-role-sessions/phase-2-server-fsm-transition-endpoint.md`.

## Changes Made

In-scope files:

- **`server/src/routes/tasks-lifecycle.ts`** — rewritten:
  - Removed `POST /tasks/:id/complete` and `POST /tasks/:id/fail`.
  - Updated `POST /tasks/:id/reset` precondition (`'completed'` → `'complete'`)
    and conflict text.
  - Updated `POST /tasks/:id/integrate` precondition (`'completed'` →
    `'complete'`) and bad-request text.
  - Added `POST /tasks/:id/transition` with the FSM transition table
    declared as a single `Record<status, ReadonlySet<target>>` constant at
    the top of the module so the table is the load-bearing artefact of the
    file. Per-target branches in `handleTransition` validate the payload and
    compose a `TransitionUpdate` object that the queries layer applies
    atomically. Cycle-budget reroute, contradiction trigger validation,
    arbitration uniqueness, verdict merge/reset, and failure-metadata writes
    all live in this single function.
  - Mandatory `X-Project-Id` check is enforced by reading the raw header
    rather than trusting the project-id plugin's `'default'` fallback.
- **`server/src/queries/tasks-lifecycle.ts`** — rewritten:
  - Deleted `complete()` and `fail()` query helpers (the only callers were
    the removed routes plus the local query test, which has been updated).
  - `reset` now matches on the new `RESETTABLE_STATUSES = ['complete',
    'failed', 'cycle']` set; `integrate*` and `getCompletedByAgent` /
    `getAllCompleted` now match on `'complete'`.
  - Added `applyTransition(db, projectId, id, expectedStatus, update)` —
    optimistic-locking write that gates on `expectedStatus`; returns the
    updated row or null. The route layer maps null to 409.
  - Added `arbitrationExists(db, taskId, trigger)` — backs the arbitration
    uniqueness check.
  - Removed the `updateProgress` helper's reliance on `TERMINAL_STATUSES`
    (it was never coupled to it; `release` now mirrors that pattern with a
    locally-declared `RESETTABLE_STATUSES`).
- **`server/src/routes/tasks-lifecycle.test.ts`** — rewritten:
  - Deleted the legacy complete/fail/reset/integrate test cases that
    exercised the removed routes (their assertions about `'completed'` and
    the legacy result.agent surface no longer apply).
  - Added a `getFsmRow` helper that reads the FSM-only columns directly
    from the DB (these are not exposed through `GET /tasks` yet).
  - Added a `driveToReviewing` helper that walks pending → claimed →
    engineering → built → reviewing for the cases that need to start at
    `reviewing`.
  - Added tests for every acceptance criterion: claimed → engineering;
    engineering → built with payload (and 400 when buildStatus or commitSha
    missing/out-of-enum); built → reviewing resets verdicts; three
    reviewing-self-loops accumulate verdicts; reviewing → complete gating
    (200 when all clear, 409 when none, 409 when one requested changes);
    pending → engineering returns 409; cycle-budget routing (reroutes to
    arbitrating with the cycle-budget trigger and increments the count;
    409 when an arbitration row already exists for the same trigger);
    revising → engineering; engineering → arbitrating with
    reviewer_contradiction (and 400 with cycle-budget trigger or missing
    trigger); arbitration uniqueness (second attempt 409); transitions out
    of arbitrating (complete / revising / failed all clear the pending
    trigger); failed-with-reason validation (400 when missing or
    out-of-enum); X-Project-Id absent → 400; unknown task → 404; legacy
    complete/fail endpoints now return 404; reset and integrate accept the
    new `'complete'` status.

Out-of-scope build fixes (minimum viable, per the build-error rule):

- **`server/src/queries/tasks-lifecycle.test.ts`** — query-level test file:
  removed the suite that exercised the now-deleted `complete()` / `fail()`
  helpers. Replaced with a `markComplete()` SQL helper that drives a task
  to `'complete'` directly so the surviving reset / integrate / getter
  tests can still run end-to-end against the new schema.
- **`server/src/queries/test-utils.ts`** — the hand-rolled SCHEMA_DDL
  used by PGlite test contexts has been updated to mirror the Phase 1
  schema: `tasks` gains the FSM columns (review_cycle_count,
  review_cycle_budget, reviewer_verdicts, latest_review_path, build_status,
  commit_sha, arbitration_pending_trigger, arbitration_addendum_path,
  failure_reason, failure_detail, agent_roles_override) plus the new
  CHECKs; the `tasks_status_check` enum lists *both* the legacy and new
  values during the transition window; `projects` gains the
  `agent_roles jsonb NOT NULL DEFAULT '{}'` column; new tables
  `review_runs`, `arbitration_runs`, `review_findings` are declared with
  their CHECKs/UNIQUEs/indexes. Without this update the new
  /transition endpoint cannot be exercised in tests.
- **`server/src/queries/projects.ts`** — added `agentRoles: {}` to the
  `create()` insert payload to satisfy the new notNull constraint. Phase 9
  will replace this default with the operator's per-project mapping.
- **`server/src/queries/agents.test.ts`**, **`server/src/queries/files.test.ts`**,
  **`server/src/routes/agents.test.ts`**, **`server/src/routes/rooms.test.ts`**,
  **`server/src/routes/sessions.test.ts`** — added `agentRoles: {}` to the
  five `db.insert(projects).values(...)` call sites enumerated in Phase 1's
  debrief as known build breaks. Identical one-line fixes.

Debrief: this file.

## Design Decisions

- **Single FSM table in the route module.** The plan's Step 2 spells out
  the table, and the prompt re-emphasises that the table is the
  load-bearing artefact ("keep it as a single in-module table per the
  plan, not split across helper files in a way that obscures the table").
  I declared `FSM` as a single `Record<status, ReadonlySet<target>>` at the
  top of the file, immediately after the type aliases. The handler reads
  the table once with `FSM[current].has(target)`; everything else
  (validation, payload binding, queries) is downstream of that lookup.
- **Transition write is a single atomic update.** `applyTransition` writes
  status + per-column fields in one `UPDATE … WHERE status = expected`,
  matching Step 3 of the plan ("on every transition, atomic write of:
  …"). The optimistic lock on `expectedStatus` collapses race recovery
  into a single 409 path.
- **Cycle-budget reroute is implemented inline in the `target ===
  'revising'` branch**, not as a separate helper function. Reading
  the plan, the reroute is *the* reason `to: 'revising'` exists as a
  client-facing target — splitting the logic across two functions would
  hide the relationship between "client asked for revising" and "server
  silently writes arbitrating instead." The branch increments the count,
  checks the budget, and either flips the write or proceeds.
- **`built → reviewing` resets verdicts to `{}` unconditionally** (Step
  3 bullet "reviewerVerdicts reset"). The route never accepts a verdict
  payload on this transition; supplying one is silently ignored. This
  matches the plan's "deliberate reset on cycle entry, not a merge."
- **`reviewing → reviewing` performs a single-key jsonb merge** read
  through the row's existing `reviewerVerdicts`, mutate one key, write the
  whole object back. PGlite/Drizzle's jsonb path-update support is
  patchy across versions; reading + writing the merged object is the
  least-surprising portable form. Step 3 explicitly says "single-key
  jsonb merge — other keys are preserved."
- **`failed` always populates `failureReason`.** Step 3 last bullet:
  "On entering `failed`: set `failureReason` (must be one of the enum
  values from Phase 1's CHECK; the endpoint rejects with 400 if
  `payload.failureReason` is missing or out-of-enum)." A blank failure is
  not a valid terminal state — the operator must always know which
  trigger the run died on.
- **Arbitration uniqueness is checked against `arbitrationRuns`, not
  `tasks.arbitrationPendingTrigger`.** A task that has already been
  arbitrated for a given trigger has *posted a ruling row* — that row is
  the durable evidence. The pending-trigger column is the in-flight
  marker that gets cleared on exit; relying on it for uniqueness would
  let a run cycle through the same arbitration twice.
- **`X-Project-Id` is read from the raw header** rather than from
  `request.projectId`. The project-id plugin defaults the value to
  `'default'` when the header is absent, which is correct for the rest
  of the surface but contradicts the plan's "X-Project-Id is mandatory;
  reject with 400 if absent" rule for `/transition`. Reading the header
  directly is the only way to distinguish "absent" from "explicitly
  'default'" without changing the plugin globally.
- **Test schema DDL extends, doesn't replace, the legacy enum.** The
  Phase 1 debrief flagged that the test DDL is intentionally outdated.
  Until Phase 9 cuts over, route-test files written against either the
  legacy `'completed'` / `'in_progress'` literals *or* the new FSM
  literals must run side-by-side. Listing both in the CHECK is the
  least-disruptive path; Phase 9 drops the legacy literals.

## Build & Test Results

- `npm run build` (in `server/`): **clean**. Zero TypeScript errors against
  the new schema.
- `npm test` (in `server/`):
  - **`server/src/routes/tasks-lifecycle.test.ts`** (the in-scope test
    file I authored): **37/37 pass**. Every acceptance criterion in the
    plan is covered by an explicit assertion.
  - **`server/src/queries/tasks-lifecycle.test.ts`** (in-scope queries
    test, rewritten to drop tests for the deleted `complete()` /
    `fail()` helpers and replace them with raw-SQL drives to the new
    `'complete'` status): **11/11 pass**.
  - Whole-suite roll-up: 605 pass, 54 fail, 0 cancelled, out of 659
    tests across 79 suites. The pre-change baseline (with my changes
    stashed) reported 476 pass, 124 fail, 64 cancelled out of 664 tests
    — i.e. my changes resolved 19 top-level test suites' worth of
    breakage and 64 cancellations that were inherited from Phase 1.
  - The remaining 54 failures are all pre-existing and split across
    four categories:
    1. `POST /agents/:name/sync (drizzle)` and `tasks with bare repo and
       agents` — fail in the container because `git -C … commit-tree` is
       run without a `user.email` / `user.name`. Pure environmental;
       tests pass on a host with git identity configured.
    2. `projects routes` — fails because `test-utils.ts` pre-seeds
       `'test-proj'` and the test asserts a fresh-create returns 201.
       Pre-existing test fixture mismatch, unrelated to FSM.
    3. `tasks routes` — same two `DELETE /tasks?status=completed`
       subtests (`deletes completed tasks and returns count`, `scopes
       deletion to the requesting project`) that fail in the baseline.
       Both depend on the legacy `POST /tasks/:id/complete` endpoint
       this phase deletes, but they were already failing pre-cutover.
       Migrating them to the `/transition` endpoint is a follow-up
       beyond this phase's file scope.
    4. The remaining failures cascade from the four categories above
       (test files that share `before` setup with a failing helper).

The plan's acceptance gate is "the lifecycle test file you author/modify
passes" and "the build is clean." Both are satisfied.

## Open Questions / Risks

- The cycle-budget reroute writes `update.reviewCycleCount = nextCount`
  even when the reroute fires — the plan's Step 2 says "the server first
  increments `reviewCycleCount`" before the budget check, so the
  exhausted state is recorded at `count = budget + 1`. I matched that
  literal reading; if the operator wants the count frozen at `budget`
  on reroute, that's a one-line change.
- I left `reviewing → arbitrating` as a *legal direct path* in the FSM
  table even though the plan describes the cycle-budget path as a server
  reroute. The plan's "Arbitration uniqueness: before allowing
  `reviewing → arbitrating` or `engineering → arbitrating`…" wording
  treats it as a real edge. The direct path requires the same trigger
  validation as the reroute and goes through the same uniqueness check;
  if the design wants reviewing → arbitrating *only* via reroute, drop
  it from the FSM table.
- `applyTransition` does not load the row again after the write; the
  response body relays only what we just wrote (status, count, verdicts,
  pending trigger). If a downstream consumer needs the full task
  payload, they should call `GET /tasks/:id`.

## Suggested Follow-ups

- The FSM types (`FsmStatus`, `RequestedTarget`, `Verdict`,
  `ArbitrationTrigger`, `FailureReason`, `BuildStatus`) currently live in
  `tasks-lifecycle.ts`. Phase 8 (dashboard rendering) will want them
  exported — extracting them to `routes/fsm-types.ts` (or
  `tasks-types.ts`) is a natural follow-up once a second consumer
  appears.
- The query test file (`server/src/queries/tasks-lifecycle.test.ts`)
  uses raw `db.execute(sql\`...\`)` to drive a task to `'complete'`. Once
  the server has a dedicated `markComplete` query helper (probably
  Phase 7 or 9), the test should switch to it.
- The `agentRoles: {}` default added to the project-insert call sites is
  a placeholder. Phase 9 must replace it with the actual per-project
  mapping seeded from `scaffold.config.json`.
