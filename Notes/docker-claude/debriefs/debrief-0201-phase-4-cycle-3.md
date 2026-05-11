# Phase 4 Cycle 3 — Align deleteById and ACTIVE_STATUSES with the FSM

## Task Summary

Address two BLOCKING findings and one WARNING from the cycle 2 correctness reviewer:

- **B1.** `tasksCore.deleteById` inner guard at `server/src/queries/tasks-core.ts` still used a hand-rolled SQL fragment `status NOT IN ('claimed', 'in_progress')`. Direct callers (bypassing the route layer) could delete tasks in FSM mid-states such as `engineering`, `built`, `reviewing`, `revising`, `arbitrating` — contradicting the FSM contract.
- **B2.** `ACTIVE_STATUSES` in `server/src/queries/query-helpers.ts` was `['claimed', 'in_progress']`. Under the FSM, the legacy `'in_progress'` is gone from the schema CHECK and the in-flight states are the six FSM-active values. Lifecycle helpers (`release`, `updateProgress`, `releaseByAgent`, `releaseAllActive`) and the coalesce queries that consume `ACTIVE_STATUSES` were silently no-opping on FSM mid-state tasks — so the live `/tasks/:id/release` path was stranding any task past `claimed`.
- **W1.** The bulk-delete protection test at `routes/tasks.test.ts:950` only exercised one FSM mid-state (`engineering`); parameterise across all six.

Out of scope (per the spec): `tasks-claim.ts:34/40/84` `'completed'` dependency checks, `task-deps.ts`, `tasks-replan.ts`. Untouched.

## Changes Made

- **`server/src/queries/query-helpers.ts`** — redefined `ACTIVE_STATUSES` as the six FSM in-flight statuses (`claimed`, `engineering`, `built`, `reviewing`, `revising`, `arbitrating`), dropping `'in_progress'` which is no longer in the schema CHECK. Added a `ACTIVE_STATUSES_SET` (`ReadonlySet<string>`) form for O(1) `.has()` callers. Single source of truth — see "Design Decisions" for why.
- **`server/src/queries/tasks-core.ts`** — replaced the raw `sql\`${tasks.status} NOT IN ('claimed', 'in_progress')\`` guard in `deleteById` with `notInArray(tasks.status, [...ACTIVE_STATUSES])`. Imported `ACTIVE_STATUSES` from `query-helpers.js`.
- **`server/src/queries/tasks-lifecycle.ts`** — dropped the `status: 'in_progress'` write in `updateProgress`; the helper now only appends to `progress_log` without changing status. See "Design Decisions / `updateProgress`" below for the reasoning. All four `ACTIVE_STATUSES` consumers in this file (`updateProgress`, `release`, `releaseByAgent`, `releaseAllActive`) inherit the new set automatically.
- **`server/src/routes/tasks.ts`** — removed the local `FSM_ACTIVE_STATUSES` set, imported `ACTIVE_STATUSES_SET` from `query-helpers.js`. The two route-level `.has()` calls (DELETE /tasks/:id, DELETE /tasks bulk) now share the same source.
- **`server/src/routes/tasks-claim.ts`** — updated the `/release` and `/update` conflict messages from "task not in claimed or in_progress state" to "task not in claimed or FSM mid-state (engineering/built/reviewing/revising/arbitrating)" to reflect the FSM terminology.
- **`server/src/queries/tasks-core.test.ts`** — renamed the line-119 test from "should delete by id if not claimed/in_progress" to "should delete by id if not in an FSM-active status". Added a new test "should not delete a task in any FSM mid-state" that exercises two FSM mid-states (`engineering`, `reviewing`) at the DB layer.
- **`server/src/queries/tasks-lifecycle.test.ts`** — added two tests: "should release a task in an FSM mid-state (engineering, reviewing)" confirming the abnormal-exit `/release` path works for FSM mid-state tasks, and "should not release a task in a terminal status (complete, failed, integrated)" confirming `release()` no-ops for terminals.
- **`server/src/routes/tasks.test.ts`** — replaced the single-status `engineering` bulk-delete test with a loop over all six members of FSM_ACTIVE_STATUSES, asserting 409 for each.
- **`server/src/queries/coalesce.test.ts`** — replaced the `'in_progress'` value in the seed-data array with `'engineering'`. Without this update the seed insert still succeeded (the test DDL still allows `'in_progress'` for now), but `countActiveTasks` etc. would only see one in-flight row after the `ACTIVE_STATUSES` change, breaking the count==2 assertions.
- **`server/src/routes/agents.test.ts`** — updated "DELETE /agents/:name releases in_progress tasks to pending" to seed an `'engineering'` task instead of `'in_progress'`. Same intent (FSM mid-state in-flight task gets released on agent deletion); test renamed to match.

## Design Decisions

### Single source of truth

The spec was explicit: "do not duplicate the FSM-active list across files". The previous state had:

- `query-helpers.ACTIVE_STATUSES` — legacy two-element tuple used by lifecycle WHERE clauses (`tasks-lifecycle.ts` × 4 sites, `coalesce.ts` × 3 sites).
- `routes/tasks.ts FSM_ACTIVE_STATUSES` — Set form added in cycle 2, used by the DELETE guards.

I unified these into one constant in `query-helpers.ts` exposed in two forms — the array (`ACTIVE_STATUSES`) for `inArray`/`notInArray` callers, and the Set (`ACTIVE_STATUSES_SET`) for the `.has()` callers in the route layer. Renaming `ACTIVE_STATUSES` was unnecessary: the semantics are unchanged, only the contents shift to reflect the FSM cutover. The Set is derived from the array, so the array remains the literal source of truth.

### `updateProgress` and the legacy `'in_progress'` write

`POST /tasks/:id/update` is the only route that called `updateProgress`, and the helper used to side-effect `status: 'in_progress'` alongside the `progress_log` append. Under the FSM:

1. `'in_progress'` is **not** in the production schema CHECK (`server/src/schema/tables.ts:131-133`), so the write would have failed at the DB layer in production. The PGlite test DDL at `server/src/queries/test-utils.ts:146-149` still lists `'in_progress'` for backward-compat during the migration, which is why the existing test masked the live failure.
2. The FSM model has role sessions own all status transitions (engineer transitions claimed → engineering, etc.). A free-floating `/update` endpoint setting `'in_progress'` would either (a) corrupt the FSM by introducing an out-of-band state or (b) need to invent some FSM-appropriate target.
3. I checked `container/`, `scripts/`, `skills/`, `dynamic-agents/`, `agents/` for callers of `/tasks/:id/update`. **There are none** — the route exists but is essentially dead code from a production standpoint. Only tests call it (`tasks-claim.test.ts:75`, `tasks-deps.test.ts:478`).

Given (1)–(3), the least-invasive fix was to drop the status write entirely. `updateProgress` now only appends to `progress_log`, gated by the same `ACTIVE_STATUSES` WHERE clause (so a no-op caller still gets a 409 conflict response). The existing tests had to be updated to expect `status: 'claimed'` after the call instead of `'in_progress'`.

Inventing a new FSM transition path through `/update` was out of scope and would have required reasoning about which FSM role the caller represents — a much larger change than this cycle warrants. Deleting the route entirely was also out of scope: it has callers in tests (which would need to migrate) and external clients I can't audit. Status-quo-preserving drop-the-write is the right move.

## Build & Test Results

- **`npm run typecheck`** — clean.
- **`npm test`** — 737 tests, **683 pass, 54 fail**, 0 cancelled. **Baseline (before my changes, on stash) was 734 tests, 680 pass, 54 fail.** I added 3 new tests (all pass) and converged the two suites I had transiently broken (`coalesce queries`, `DELETE /agents task release`). The remaining 54 failures are unchanged in identity from baseline:
  - `not ok 22 - POST /agents/:name/sync (drizzle)` — pre-existing git `user.email` configuration issue.
  - `not ok 42 - projects routes` — pre-existing.
  - `not ok 54 - tasks with bare repo and agents` — pre-existing.
  - `not ok 59 - tasks routes` — pre-existing (mostly `status=completed` queries against the FSM-era `complete`/`integrated` enum).
- **Shell-script syntax checks** — `bash -n launch.sh setup.sh status.sh stop.sh scripts/launch-team.sh` all pass.

## Open Questions / Risks

- The PGlite test DDL at `server/src/queries/test-utils.ts:146-149` deliberately keeps both `'in_progress'` and the FSM mid-states valid during the migration ("After Phase 9 the legacy values are dropped from this CHECK"). When that cleanup lands, any remaining test that seeds `'in_progress'` directly via `db.insert(tasks)` will break. I migrated two such tests (`coalesce.test.ts`, `agents.test.ts`); the spec explicitly told me not to touch others. A grep for `status: 'in_progress'` or `status='in_progress'` in `server/src/**/*.test.ts` would surface the remaining ones for a future cleanup pass.
- `POST /tasks/:id/update` is a live HTTP route that no production code calls. Worth flagging for a future cleanup decision: rename, delete, or rewire to an FSM-aware status target.

## Suggested Follow-ups

- Audit the remaining `'completed'` / `'in_progress'` references in `tasks-claim.ts:34/40/84`, `task-deps.ts`, `tasks-replan.ts` — the cycle 2 reviewer flagged them as orthogonal, but they will eventually need to follow the same FSM-rename treatment as `'complete'`.
- Decide on the fate of `POST /tasks/:id/update` — drop, repurpose, or rewire under the FSM transition vocabulary.
- When the PGlite test DDL drops legacy `'in_progress'`/`'completed'`, sweep all `*.test.ts` files for the remaining direct-DB seeds.
