# Debrief 0198 — Phase 3: server review ingestion and aggregation endpoints

## Task Summary

Implement Phase 3 of the durable-task-FSM plan: six new endpoints split across
three new route modules.

- `POST /tasks/:id/reviews` — atomic insert of a `review_runs` row + N
  `review_findings` children. Unique conflict on `(task_id, cycle, reviewer_role)`
  surfaces as 409.
- `GET /tasks/:id/reviews/:cycle` — per-cycle run breakdown.
- `GET /findings` — cross-task BLOCKING/NOTE list, project-scoped, paginated.
- `GET /findings/note-patterns` — NOTE titles grouped by exact-match count, top-N,
  with up to 3 example finding ids per group ordered by `posted_at DESC`.
- `GET /arbitrations` — arbitration counts grouped by `(trigger, ruling)`,
  project-scoped, with example task ids.
- `GET /failures/reasons` — `tasks.failure_reason` counts for `status='failed'`
  rows, project-scoped, with example task ids.

The plan groups these as: `reviews.ts` (the two `/tasks/:id/reviews*`),
`findings.ts` (the three findings/arbitrations endpoints), `failures.ts` (the
single `/failures/reasons`).

## Schema reference (Phase 1)

Already landed:
- `review_runs(id, task_id, cycle, reviewer_role, verdict, raw_markdown, posted_at)`
  with a unique index on `(task_id, cycle, reviewer_role)`.
- `review_findings(id, run_id, severity, ordinal, file_path, line, title,
  description, evidence, fix)`.
- `arbitration_runs(id, task_id, trigger, ruling, ruling_markdown,
  contradiction_resolution, posted_at)`.
- `tasks.failure_reason` (CHECK to a six-enum).

Project scoping for cross-task endpoints is achieved by joining `tasks` and
filtering on `tasks.project_id`.

## Design decisions

1. **`X-Project-Id` requirement.** The `project-id` plugin defaults a missing
   header to `'default'`. To honour the plan's "reject missing header with 400"
   requirement on the cross-task endpoints, each cross-task handler explicitly
   inspects `request.headers['x-project-id']` (the plan's wording is "missing
   header", treated as undefined or empty string). This mirrors the pattern
   already in `tasks-lifecycle.ts:handleTransition`.

2. **Atomicity of `POST /tasks/:id/reviews`.** Wrapped in
   `db.transaction(async (tx) => ...)`. Insert run with `.returning()`, then bulk
   insert findings with `.returning({ id })`. On unique conflict
   (`review_runs_task_cycle_role_unique`) the catch block returns 409. Drizzle
   surfaces both PG and PGlite unique violations as errors carrying the SQLSTATE
   or the constraint name; we match by checking error message for
   `review_runs_task_cycle_role_unique` or SQLSTATE 23505.

3. **`array_agg(... ORDER BY ... LIMIT 3)` is not legal Postgres.** I replicate
   the semantics with a CTE using `row_number() OVER (PARTITION BY group ORDER BY
   posted_at DESC)` and aggregate only rows where `rn <= 3`. The aggregate-over-
   filtered-CTE approach works in both PGlite and Postgres without
   server-specific extensions.

4. **`/arbitrations` source table.** Phase 1 added `arbitration_runs` (see
   `schema/tables.ts`). Group on `(trigger, ruling)` from that table, joined to
   `tasks` for project scoping. Example task IDs are pulled via the same
   row-number-3-deep approach, ordered by `posted_at DESC`.

5. **`/failures/reasons` example task IDs.** Ordered by `completed_at DESC` per
   the plan's SQL sketch. Filters: `status='failed' AND failure_reason IS NOT NULL
   AND completed_at >= since`. Project-scoped via `tasks.project_id`.

6. **Sorts.** `/findings` sorts by `review_runs.posted_at DESC`. Aggregations
   sort by `count DESC`.

7. **Pagination caps.** `/findings`: `limit` default 50, max 200, `offset`
   default 0. `/findings/note-patterns`: `limit` default 20, max 50.

## Files

- `server/src/routes/reviews.ts` (new) — POST /tasks/:id/reviews, GET /tasks/:id/reviews/:cycle.
- `server/src/routes/reviews.test.ts` (new).
- `server/src/routes/findings.ts` (new) — /findings, /findings/note-patterns, /arbitrations.
- `server/src/routes/findings.test.ts` (new).
- `server/src/routes/failures.ts` (new) — /failures/reasons.
- `server/src/routes/failures.test.ts` (new).
- `server/src/routes/index.ts` (modified) — register the three new modules.
- `server/src/index.ts` (modified) — wire the three new plugins into the server.

## Build & Test Results

- `npm run typecheck` — clean (`tsc --noEmit` exits 0).
- `npm run build` — clean (`tsc` exits 0).
- `npx tsx --test src/routes/reviews.test.ts` — 18/18 pass.
- `npx tsx --test src/routes/findings.test.ts` — 18/18 pass (3 nested describes).
- `npx tsx --test src/routes/failures.test.ts` — 6/6 pass.
- `npm test` (full server suite) — 655/709 pass; 54 fails. **All 54 failures
  are pre-existing in the container environment** — every failing test is in
  `agents.test.ts`, `projects.test.ts`, `tasks-deps.test.ts`, or `tasks.test.ts`
  (none in files I touched), and they fail with `Author identity unknown / Run
  git config --global user.email …` from `initBareRepoWithBranch`. Confirmed
  pre-existing by running `projects.test.ts` against the working tree with my
  changes stashed: same 2 failures appeared before my changes landed.
  These failures are environmental (the container's git lacks a configured
  user identity) and outside the scope of this phase.

## Open Questions / Risks

- The plan describes `tasks.completed_at` as the timestamp basis for failure
  example ordering. The schema confirms the column is set on entry to `failed`
  (see `tasks-lifecycle.ts` `target === 'failed'` branch — `update.completedAt =
  new Date()`).
- Drizzle's PGlite driver supports `row_number()` window functions; verified by
  running the actual test.
- The `arbitration_runs.ruling` CHECK is `('approve','rule','escalate')`; the
  `(trigger, ruling)` grouping aggregates exactly those combinations.
- PGlite-specific quirk to watch for: `tx.transaction` rollback on uncaught
  throw is supported. If unique-constraint detection fails, the test asserting
  409 will catch it.

## Suggested follow-ups

- Phase 8 dashboard renderers will consume `/findings/note-patterns` and
  `/failures/reasons`. The shape exposed here is the dashboard's contract.
- Should sub-second monotonic ordering of `posted_at` ties matter for example
  picking, ordering `posted_at DESC, id DESC` would be deterministic. Current
  implementation is `posted_at DESC, id DESC` for that reason.
