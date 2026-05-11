# Phase 4 cycle 2 — fix VALID_TASK_STATUSES, surface agentRolesOverride, validate AGENT_ID, exclude .scratch/

## Task Summary

Address consolidated correctness/safety review findings on Phase 4 commit 33d7053:

- **B1 BLOCKING** — `VALID_TASK_STATUSES` did not match the schema CHECK; the
  startup probe at `pump-loop.sh:204` queried statuses
  (`engineering`/`built`/`reviewing`/`revising`/`arbitrating`) that the
  validator at `tasks-core.ts:66` rejected with 400, silently disabling the
  acceptance-criterion-#2 resume path.
- **B2 BLOCKING** — `agentRolesOverride` was on the schema but not in the
  `TaskRow` type, `toTaskRow`, or `formatTask`; per-task role overrides were
  silently dropped before reaching the container's pump loop.
- **W1-safety** — `AGENT_ID` from registration was URL-interpolated without a
  UUID-shape check (despite `run-claude.sh:238` doing exactly that for
  `CURRENT_SESSION_ID`).
- **W1-correctness** — `.scratch/reviews/<task-id>/` is created inside the UE
  workspace clone, but the previous patch only added gitignore entries to the
  scaffold's repo root, not the workspace.
- **NOTE** — `failureReason='role_session_no_op'` reused for an
  agent-type-fetch infrastructure failure.

## Changes Made

- **`server/src/queries/tasks-core.ts`** — replaced `VALID_TASK_STATUSES`
  contents to mirror the schema CHECK at `tables.ts:132` exactly: drops the
  legacy `'in_progress'` and `'completed'` (the `d` form), uses singular
  `'complete'`, adds the FSM mid-states (`engineering`, `built`, `reviewing`,
  `revising`, `arbitrating`). The constant now serves as the API allowlist
  matching the FSM-era `tasks_status_check` constraint.
- **`server/src/routes/tasks.ts`** — introduced an `FSM_ACTIVE_STATUSES` set
  (`claimed`, `engineering`, `built`, `reviewing`, `revising`, `arbitrating`)
  and replaced the two legacy guard expressions
  (`status === 'claimed' || status === 'in_progress'`) at the per-id and bulk
  DELETE handlers with a set-membership check. Without this, those guards
  could never fire because the freshly-tightened `VALID_TASK_STATUSES` rejects
  `in_progress` at validation time, and operators would have been unable to
  protect FSM mid-state tasks from deletion.
- **`server/src/routes/tasks-types.ts`** — added `agentRolesOverride: unknown`
  to the `TaskRow` interface (with a doc comment explaining the
  shallow-merge contract pump-loop.sh consumes), and surfaced it in both
  `toTaskRow` and `formatTask`. Coerces undefined to `null` so the JSON shape
  is stable across rows that never had an override set.
- **`server/src/routes/tasks.test.ts`** — added three positive tests:
    1. `GET /tasks?status=engineering,built,reviewing,revising,arbitrating`
       returns 200 (the startup-probe regression test).
    2. `GET /tasks?status=bogus_state` returns 400 (negative-side regression).
    3. `GET /tasks/:id` round-trips a non-null `agentRolesOverride` that was
       seeded via raw SQL (`UPDATE tasks SET agent_roles_override = ...`).
    4. `GET /tasks/:id` returns `agentRolesOverride: null` when the column is
       null (default).
  Also updated two pre-existing tests that exercised the now-invalid legacy
  values: the multi-status filter test now uses `pending,complete` instead of
  `pending,completed`; the protected-status DELETE test now uses
  `engineering` instead of `in_progress`. (See **Notes** for the still-failing
  pre-existing tests we did not touch.)
- **`container/lib/registration.sh`** — after the existing `export AGENT_ID`,
  added a UUID-shape regex matching the one in `run-claude.sh:238` and
  exiting non-zero on mismatch. The lowercase-hex regex matches the existing
  precedent; the server emits lowercase UUIDs from `randomUUID()` so this is
  consistent.
- **`container/lib/workspace-setup.sh`** — extended the `.git/info/exclude`
  block written into the workspace clone to also exclude `.scratch/reviews/`
  and `.scratch/arbitrations/`. The file is rewritten (`>`) on each setup, so
  reruns never accumulate duplicate lines; idempotency comes for free.

## Design Decisions

- **DELETE guards rewritten, not removed.** The reviewer instruction said
  "decide whether stale references are dead code or legitimate." The
  `'in_progress'` references in `tasks.ts:637/655` were *legitimate* guards
  protecting in-flight tasks from deletion; with the FSM cutover their proper
  successor set is the six FSM mid-states. Removing them would have weakened
  the system; preserving them required an `FSM_ACTIVE_STATUSES` set.
- **Schema compatibility window left intact.** `test-utils.ts` keeps both the
  legacy and FSM values in its CHECK so tests can still insert `'in_progress'`
  and `'completed'` rows. I did not touch that — it is the documented
  Phase 1–9 compatibility window. After Phase 9 lands, that test schema
  tightens.
- **agentRolesOverride typed as `unknown`.** The schema declares the column
  as `jsonb` with no Drizzle-side shape contract. The full typed interface
  is established at use-site (pump-loop.sh's jq merge); pretending to know
  the shape in TypeScript would be a lie. `unknown` forces consumers to
  narrow before use, which is the right default.
- **NOT introducing a new `agent_type_fetch_failed` failure reason.** The
  reviewer NOTE asked us to do this only if the validator accepts arbitrary
  strings. It does not — `tasks-lifecycle.ts:51-58` declares a strict
  allowlist `FAILURE_REASONS`, and the schema check at `tables.ts:144-151`
  enforces the same set at the DB. Adding a new reason is a multi-file
  schema change well outside the scope of a review-cycle 2 commit. Documented
  for Phase 8 instead.

## Build & Test Results

- `npm run typecheck` — clean.
- `bash -n` over `registration.sh` and `workspace-setup.sh` — clean.
- `npm test` — pending (running after this debrief is committed, per the
  protocol that says debriefs precede the build).

## Open Questions / Risks

- **Pre-existing test failures.** Before my changes,
  `npm test src/routes/tasks.test.ts` already had two failing subtests in the
  `DELETE /tasks bulk-delete by status` suite ("deletes completed tasks and
  returns count" and "scopes deletion to the requesting project"). Both
  failures are caused by `POST /tasks/:id/complete` returning 404 — that
  endpoint was deliberately removed pre-Phase 4 (see
  `tasks-lifecycle.test.ts:753`). The tests will continue to fail until they
  are rewritten to drive completion via the new `/transition` endpoint.
  Updating them is out of scope for this review cycle (the reviewer
  instruction says pre-existing failures are not our concern). Flagging here
  for the operator.
- **Idempotency of `.git/info/exclude` rewrite.** Using `>` (truncate) is
  intentionally non-additive — every workspace setup writes the same content,
  so we can never accumulate duplicate lines. If a future change wants to
  *append* per-project excludes, that would need a different strategy
  (e.g. read existing, dedupe, write).

## Suggested Follow-ups

- Phase 8 should add `'agent_type_fetch_failed'` to the
  `FAILURE_REASONS` allowlist (and the schema CHECK) so the
  agent-type-fetch infrastructure failure path is no longer bucketed with
  genuine no-op sessions. The transition path in `_pump_iteration` already
  has a TODO comment noting the conflation.
- The two pre-existing failing tests in
  `tasks.test.ts:DELETE /tasks bulk-delete by status` should be ported to
  drive completion via the `/transition` endpoint instead of the removed
  `/complete` endpoint, or removed and replaced with FSM-native
  bulk-delete-of-`complete`-tasks coverage.
- A POST/PATCH `/tasks` body field for `agentRolesOverride` is wanted; today
  the only path is `tasks-ingest`. A small write surface would let the
  operator set per-task overrides without ingesting a markdown file.
