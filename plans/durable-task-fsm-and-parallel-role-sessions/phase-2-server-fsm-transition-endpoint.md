---

# Phase 2 — Server FSM transition endpoint

Part of [Plan: Durable Task FSM and Parallel Role Sessions](./_index.md). See the index for the shared goal and context — this phase body assumes them.

**Files:**
- `server/src/routes/tasks-lifecycle.ts`
- `server/src/routes/tasks-lifecycle.test.ts`
- `server/src/queries/tasks-lifecycle.ts` (the queries module backing the lifecycle routes — its `complete()` and `fail()` query helpers are deleted alongside the route handlers)

**Work:**

0. **Legacy lifecycle endpoint disposition.** Delete `POST /tasks/:id/complete` and `POST /tasks/:id/fail` from `server/src/routes/tasks-lifecycle.ts` and the corresponding query helpers (`tasksLifecycleQ.complete`, `tasksLifecycleQ.fail`) from `server/src/queries/tasks-lifecycle.ts`. Both are superseded by `POST /tasks/:id/transition`. Their existing `claimed | in_progress` precondition would break the moment the new schema lands (`'in_progress'` no longer exists), and keeping them as parallel write paths to the same FSM rows would split the source of truth. Keep `POST /tasks/:id/reset` (operator-facing, recovers a `failed`/`cycle`/`complete` task to `pending`) and `POST /tasks/:id/integrate` + `/integrate-batch` + `/integrate-all` (operator-facing, marks `complete` rows as `integrated`) — these are unchanged in semantics and continue to coexist with `/transition`.

   **Update the surviving endpoints' status checks** so they reference the new enum values rather than the deprecated `'completed'`. Concretely:
   - `POST /tasks/:id/reset` ([server/src/routes/tasks-lifecycle.ts:57](../../server/src/routes/tasks-lifecycle.ts)): change the precondition from `row.status !== 'completed' && row.status !== 'failed' && row.status !== 'cycle'` to `row.status !== 'complete' && row.status !== 'failed' && row.status !== 'cycle'`. Update the conflict message text to match.
   - `POST /tasks/:id/integrate` ([server/src/routes/tasks-lifecycle.ts:109](../../server/src/routes/tasks-lifecycle.ts)): change `row.status !== 'completed'` to `row.status !== 'complete'`. Update the bad-request message text.
   - `tasksLifecycleQ.reset`, `tasksLifecycleQ.integrate`, `tasksLifecycleQ.integrateBatch`, `tasksLifecycleQ.integrateAll` in `server/src/queries/tasks-lifecycle.ts`: anywhere these reference `'completed'` in WHERE clauses or precondition checks, replace with `'complete'`. Without this sweep the surviving endpoints reject every task post-cutover (the new schema rejects `'completed'` at the CHECK; the queries would silently filter nothing).

1. Add `POST /tasks/:id/transition` accepting:
   ```
   {
     "to": "engineering" | "built" | "reviewing" | "revising" |
           "arbitrating" | "complete" | "failed",
     "payload": {
       // build/commit fields, used on engineering→built
       "buildStatus"?: "clean" | "dirty" | "failed",
       "commitSha"?: string,

       // per-reviewer verdict update, used while staying in reviewing
       "reviewerRole"?: string,
       "verdict"?: "approve" | "request_changes" | "out_of_scope",

       // workspace pointer, used on reviewing→revising
       "latestReviewPath"?: string,

       // arbitration entry, used on engineering→arbitrating and reviewing→arbitrating
       "trigger"?: "review_cycle_budget_exhausted" | "reviewer_contradiction",
       "contradiction"?: { "findingIds": [int, int], "notes": string },

       // failure metadata, used on any →failed
       "failureReason"?: "review_cycle_budget_exhausted" | "reviewer_contradiction" |
                         "engineer_build_failure" | "reviewer_infrastructure_failure" |
                         "role_session_no_op" | "arbitrator_escalated",
       "failureDetail"?: string
     }
   }
   ```
2. Implement the FSM as a single transition table inside the route module:
   ```
   pending       → claimed
   claimed       → engineering | failed
   engineering   → built | arbitrating | failed
   built         → reviewing | failed
   reviewing     → reviewing   (per-reviewer verdict update; stays here until all in)
   reviewing     → complete    (only when every declared reviewer has verdict ∈ {approve, out_of_scope})
   reviewing     → revising    (any verdict == request_changes; reviewCycleCount++ at this transition)
   reviewing     → arbitrating (would-be → revising but reviewCycleCount+1 > reviewCycleBudget)
   revising      → engineering
   arbitrating   → complete    (arbitrator ruling = 'approve')
   arbitrating   → revising    (arbitrator ruling = 'rule'; engineer re-engages with one finding upheld)
   arbitrating   → failed      (arbitrator ruling = 'escalate')
   complete      → integrated  (existing flow; out of scope here)
   any non-terminal → failed
   ```
   **Cycle-budget routing:** on what would be `reviewing → revising`, the server first increments `reviewCycleCount` and checks the budget. If `reviewCycleCount > reviewCycleBudget`, route to `arbitrating` with the trigger seeded as `'review_cycle_budget_exhausted'` instead of to `revising`. The container does not need to know the budget — the server enforces this rule centrally so the daisy-chain stays dumb.

   **Contradiction routing:** the engineer posts `engineering → arbitrating` directly when it detects a reviewer contradiction (Phase 5 escape hatch), with `trigger='reviewer_contradiction'` in the payload. No server-side rerouting needed.

   **Arbitration uniqueness:** before allowing `reviewing → arbitrating` or `engineering → arbitrating`, the server checks for an existing `arbitrationRuns` row with the same `(taskId, trigger)`. If one exists, reject with 409 — a task cannot be arbitrated twice for the same trigger. The operator must reset the task instead.
3. On every transition, atomic write of:
   - `status` to the new state.
   - Per-payload field updates (`buildStatus`, `commitSha`, `latestReviewPath`) when the transition supplies them.
   - **Per-reviewer verdict merge** (used only on the `reviewing → reviewing` self-loop): when the payload supplies `reviewerRole` + `verdict`, perform a single-key jsonb merge `reviewerVerdicts[reviewerRole] = verdict`. Other keys in `reviewerVerdicts` are preserved. The full object is never overwritten on this transition.
   - **`reviewerVerdicts` reset** (used on `built → reviewing`): set the whole object to `{}`. This is a deliberate reset on cycle entry, not a merge.
   - **On entering `arbitrating`:** set `arbitrationPendingTrigger` to the value of `payload.trigger`.
   - **On exiting `arbitrating`** (to any of `complete`, `revising`, `failed`): clear `arbitrationPendingTrigger` to NULL.
   - **On entering `failed`:** set `failureReason` (must be one of the enum values from Phase 1's CHECK; the endpoint rejects with 400 if `payload.failureReason` is missing or out-of-enum). Set `failureDetail` if supplied.
4. Reject invalid transitions with HTTP 409 and a body that names the current state and the requested target.
5. Reject the request with 400 if the payload fields the FSM requires for that transition are missing (e.g. `built` without `commitSha`).
6. `X-Project-Id` header is mandatory; reject with 400 if absent.

**Acceptance criteria:**
- A task in `pending` can be claimed via the existing `POST /tasks/claim-next` (unchanged) and that endpoint sets status to `claimed`. `POST /tasks/:id/transition {to: 'engineering'}` then succeeds.
- `POST /tasks/:id/transition {to: 'built', payload: {buildStatus: 'clean', commitSha: 'abc123'}}` from `engineering` succeeds and sets the columns.
- `POST /tasks/:id/transition {to: 'reviewing'}` from `built` resets `reviewerVerdicts` to `{}` and sets status to `reviewing`.
- Three sequential `POST /tasks/:id/transition {to: 'reviewing', payload: {reviewerRole, verdict}}` calls (one per declared reviewer) each succeed with status remaining `reviewing` and `reviewerVerdicts` accumulating.
- A final `POST /tasks/:id/transition {to: 'complete'}` succeeds only when every declared reviewer has approved or declared out-of-scope; otherwise returns 409.
- `POST /tasks/:id/transition {to: 'engineering'}` from `pending` returns 409 (skips `claimed`).
- A `request_changes` verdict that would cause `reviewCycleCount` to exceed `reviewCycleBudget` transitions to `arbitrating` (not `failed`, not `revising`), with no `arbitrationRuns` row yet.
- `POST /tasks/:id/transition {to: 'arbitrating', payload: {trigger: 'reviewer_contradiction', ...}}` from `engineering` succeeds when no prior arbitration row exists for that trigger.
- A second attempt to enter `arbitrating` for the same `(taskId, trigger)` returns 409.
- From `arbitrating`, transitions to `complete`, `revising`, and `failed` are all valid (each gated on a corresponding arbitration POST landing first; see Phase 7).
