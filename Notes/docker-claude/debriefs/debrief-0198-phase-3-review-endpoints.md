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

## Cycle 2 — review fixes

Addressed Safety BLOCKING B1, B2, B3 and WARNING W1, W2, W4, plus Correctness
WARNING W1, W3 from the Phase 3 review pass.

### Code changes

- `server/src/routes/reviews.ts`
  - `POST /tasks/:id/reviews`: now requires `X-Project-Id` (raw-header check
    matches the existing pattern in `tasks-lifecycle.ts`); the existence
    check joins `tasks.project_id = request.projectId` so a foreign-project
    task surfaces as 404. Same shape as task-not-found to avoid leaking
    cross-project task existence.
  - `GET /tasks/:id/reviews/:cycle`: same `X-Project-Id` requirement and
    project-scoped existence check. A task in another project returns 404; an
    absent cycle on an in-project task still returns `{ cycle, runs: [] }`
    (the dashboard polls for un-posted cycles, so 200/empty is the correct
    semantic for that case — only "task not in this project" is 404).
  - Added length caps: `RAW_MARKDOWN_MAX = 512_000`, `DESCRIPTION_MAX = 32_768`,
    `EVIDENCE_MAX = 32_768`, `FIX_MAX = 32_768`. `TITLE_MAX` unchanged at 1024.
  - Dropped `postedAt` from the GET /tasks/:id/reviews/:cycle runs response
    to match the plan's specified shape `{ reviewerRole, verdict, rawMarkdown,
    findings }`.
- `server/src/routes/findings.ts`
  - Severity-validation order reversed: invalid value now rejected before the
    type-narrowed assignment.
  - `reviewer` query param: applies the same regex (`/^[A-Za-z0-9_-]+$/`) and
    length cap (64) as the POST body. Malformed values reject with 400.
  - `parseLimit`: a non-positive or non-numeric explicit `limit` now returns
    a `LIMIT_INVALID` sentinel; both `/findings` and `/findings/note-patterns`
    reply 400 in that case. Missing/empty `limit` still falls back to the
    default. Affects `limit=0`, `limit=-1`, `limit=abc`.
  - `requireProjectIdHeader`: tightened to handle duplicate (array-form)
    headers — only `[0]` counts and must be non-empty. Keeps the
    "missing/empty rejects 400" behaviour intact.
- `server/src/routes/failures.ts`
  - `requireProjectIdHeader`: same array-header tightening as `findings.ts`.

### Atomicity test refactor (Correctness W1)

The pre-existing "rollback" test (`rolls back the run insert when a finding
insert fails`) catches body-validation failure before any insert hits the DB,
so it does not actually exercise the transactional rollback path. I added a
new test (`on unique conflict leaves DB with one run and zero new findings`)
that:

1. Posts a successful first review run with one finding ('first finding').
2. Posts a second run with the same `(taskId, cycle, reviewerRole)` and two
   different findings — expects 409.
3. Asserts the DB has exactly one run with the original verdict/markdown
   intact, and exactly one finding row whose title is 'first finding'.

That third assertion is load-bearing: the failed second POST must commit
nothing, including its findings. This validates that
`db.transaction(async tx => { ... })` actually rolls back the wrapping
transaction on the unique violation.

I went with option (b) from the plan rather than (a) or (c): exploiting a
DB-level CHECK violation would have required a body-validator bypass that
doesn't exist; the unique-constraint approach exercises the transactional
guarantee through the existing public surface.

### New tests

In `reviews.test.ts` (27 tests, was 18):
- POST/GET reject missing `X-Project-Id` (2 tests).
- POST/GET return 404 when the task belongs to a different project; POST
  also asserts no row was inserted (2 tests).
- `rawMarkdown`, `description`, `evidence`, `fix` length-cap rejections
  (4 tests).
- The new unique-conflict atomicity test (1 test). Existing "rollback when
  validator catches bad ordinal" test left in place — it covers the
  before-insert path, the new test covers the during-insert path.

Cross-project tests use `proj-a` (seeded by `test-utils.ts`) for the foreign
task and `default` for the requester (or vice versa). Initially I tried
`proj-b` but that project is not seeded, which surfaces as a FK violation on
`tasks.project_id → projects.id`.

In `findings.test.ts` (25 tests, was 18):
- `reviewer` rejects characters outside the regex and values over the
  64-char cap (2 tests).
- `/findings` rejects `limit=0`, `limit=-1`, `limit=abc` with 400 (3 tests).
- `/findings/note-patterns` rejects `limit=0`, `limit=-1` with 400 (2 tests).

`failures.test.ts` unchanged in test count (6) — the array-header tightening
in `failures.ts` does not change observable behaviour for any input the
existing tests cover.

### Build & test results (cycle 2)

- `npm run typecheck` — clean.
- `npm run build` — clean.
- `npx tsx --test src/routes/reviews.test.ts` — 27/27 pass.
- `npx tsx --test src/routes/findings.test.ts` — 25/25 pass.
- `npx tsx --test src/routes/failures.test.ts` — 6/6 pass.
- `npm test` — 671/725 pass; 54 fails. Same 54 environmental failures as
  cycle 1 — all in `agents.test.ts`, `projects.test.ts`, `tasks-deps.test.ts`,
  `tasks.test.ts`; all surface "Author identity unknown / Run git config
  --global user.email …" from `initBareRepoWithBranch` (200 occurrences of
  that error message in the test log). None are in the files this cycle
  modified.

### Out of scope (not addressed, per the cycle-2 brief)

- W3 (array-header guard) — moot for the new `request.projectId` paths in
  `reviews.ts`. Tightened in `findings.ts` and `failures.ts` while passing
  through.
- W5 (409 message reflection) — left as-is; `reviewerRole` is regex-validated
  on the way in, so the 409 reflection is safe.

## Cycle 3 — safety review fixes (W1, W2)

Addressed the two remaining safety WARNINGs from the cycle-2 review.

### W1 — `X-Project-Id` array-header guard asymmetry

The inline guards in `reviews.ts` (`POST /tasks/:id/reviews` and
`GET /tasks/:id/reviews/:cycle`) checked `rawHeader === undefined ||
rawHeader === ''` — they did not unpack the array form that Node's HTTP
layer produces when a header is sent twice. `findings.ts` and `failures.ts`
already handled this correctly via local `requireProjectIdHeader` helpers
that did `Array.isArray(raw) ? raw[0] : raw` before the empty check.

**Design choice**: extracted a shared helper module at
`server/src/routes/_project-id-guard.ts`, exporting
`requireProjectIdHeader(request, reply): boolean`. Updated all three route
modules to import it; removed the duplicated local helpers from
`findings.ts` and `failures.ts` and replaced the inline guards in
`reviews.ts`. Behaviour is identical for every input the existing tests
cover. The shared module name is prefixed with `_` to mark it as an internal
helper — Fastify auto-loaders that scan `routes/` for `FastifyPluginAsync`
default exports will simply ignore it because it has no default export.

The fall-back to inlining the array unpack (matching the previous
`findings.ts` shape) was the alternative; I rejected it because it would
have left three nearly-identical copies of the same guard floating around
the codebase, making future drift more likely (which is exactly the bug
class W1 calls out).

### W2 — `isUniqueRunConflict` fallback too broad

The previous fallback path `code === '23505' && message.toLowerCase()
.includes('unique')` would have misreported any future unique-violation on
`review_runs` — say, an index added later for an unrelated workflow — as a
duplicate `(taskId, cycle, reviewerRole)` 409. Tightened the fallback to
require the message to mention the specific constraint name:

```ts
return code === '23505'
  && message.includes('review_runs_task_cycle_role_unique');
```

The primary path (matching `.constraint` or `.constraint_name`) is
unchanged, and the recursive `cause` walk is unchanged. The existing 409
conflict test still passes — both PGlite and Postgres surface the
constraint name in the error message text, so the narrowed match still
catches the real-world conflict.

If a migration ever renames the constraint, the cycle-2 test
`returns 409 on duplicate (taskId, cycle, reviewerRole)` will break and the
diff author will be forced to update both the migration and this matcher in
the same change. That is the correct trade-off — silent misclassification
is worse than a loud test failure.

### Array-header test (Fastify-injector caveat)

I added two unit-level tests for the shared guard in `reviews.test.ts`:

- `shared guard rejects array-form X-Project-Id when first element is empty`
- `shared guard accepts array-form X-Project-Id when first element is
  non-empty`

These test the helper directly because Fastify's `app.inject` (via
light-my-request) **flattens** an array-valued header into a single
comma-joined string before dispatching to the route. I confirmed this with
a small experiment: `inject({ headers: { 'x-project-id': ['', ''] } })`
arrives at the handler as the literal string `,` (non-empty, accepted by
the guard's empty check). The array branch in the guard is therefore
unreachable through the test injector, but it is exercised by real HTTP
traffic — Node's `http` module preserves duplicate same-named headers as
`string[]`. The unit tests construct fake request/reply objects to drive
the guard directly; this keeps the array-handling contract under test
without requiring an integration harness on top of Node's raw HTTP server.

### Files

- `server/src/routes/_project-id-guard.ts` (new) — shared helper.
- `server/src/routes/reviews.ts` (modified) — imports shared guard, removes
  inline checks; tightens `isUniqueRunConflict` fallback to require the
  specific constraint name.
- `server/src/routes/findings.ts` (modified) — removes local guard, imports
  shared one. No `FastifyRequest` / `FastifyReply` imports needed any more.
- `server/src/routes/failures.ts` (modified) — same.
- `server/src/routes/reviews.test.ts` (modified) — adds two unit tests for
  the shared guard's array-header path.

### Build & test results (cycle 3)

- `npm run typecheck` — clean.
- `npm run build` — clean.
- `npx tsx --test src/routes/reviews.test.ts` — 29/29 pass (was 27).
- `npx tsx --test src/routes/findings.test.ts` — 25/25 pass.
- `npx tsx --test src/routes/failures.test.ts` — 6/6 pass.
- `npm test` (full server suite) — 673/727 pass; 54 fails. Pass count up
  by 2 (the two new shared-guard tests); fail count unchanged at 54.
  The 54 environmental failures are the same pre-existing
  `Author identity unknown / Run git config --global user.email` failures
  in `agents.test.ts`, `projects.test.ts`, `tasks-deps.test.ts`, and
  `tasks.test.ts` carried over from cycles 1 and 2.

### Open questions / risks

None. The shared guard is a strict generalisation of the three previous
local copies; the fallback tightening narrows behaviour without
contradicting either driver's actual error shape.

## Cycle 4 — decomposition fixes

Addressed the decomposition reviewer's BLOCKING B1, B2 and WARNING W1, W2,
W3 from the cycle-3 review pass. No behaviour change, no error-message
content change — pure consolidation.

### B1 / B2 / W1 / W2 — shared route helpers

Created `server/src/routes/_route-helpers.ts` to house the parsing and
validation helpers that were previously duplicated across `failures.ts` and
`findings.ts` (and partially in `reviews.ts`). Exports:

- `DEFAULT_SINCE_MS` — 30-day window constant.
- `parseSince(raw)` — returns `Date | null` (null = unparseable).
- `parseSinceParam(reply, raw)` — wrapper that sends a 400 on failure and
  returns `null`. Collapses ~5 lines per call site to 2.
- `normalizeIdArray(raw)` — normalises Postgres array column results across
  drivers (node-postgres returns JS array; PGlite sometimes text `{1,2,3}`).
- `rowsOf<T>(result)` — typed cast helper for `db.execute(sql\`...\`)`
  results. Used by all three CTE call sites; the join shapes differ enough
  that a fully-parameterised CTE helper would be worse than the duplication
  (the reviewer explicitly preferred option (b) — cast only).
- `REVIEWER_ROLE_RE`, `REVIEWER_ROLE_MAX` — regex / length cap constants.
- `reviewerRoleError(value, fieldName)` — validates length/charset and
  returns the 400 message or `null`. The `fieldName` parameter selects
  `reviewerRole` vs. `reviewer` wording. Empty-string and wrong-type
  rejection live at the call sites because their wording differs
  (`reviewerRole must be a non-empty string` in the POST body validator
  vs. the `findings.ts` reviewer query param which only enters the helper
  when `length > 0`).

### W3 — POST body validation extracted

In `reviews.ts`, the 88-line inline body validator in
`POST /tasks/:id/reviews` was extracted to two pure helpers in the same
file:

- `validatePostReviewBody(raw): ValidationResult<PostReviewBody>` — the
  whole-body validator.
- `validateFinding(f, i): ValidationResult<FindingInput>` — one per
  `findings[]` element, indexed for error wording.

Both helpers return a tagged union `{ ok: true, value } | { ok: false,
message }`. The handler is now:

```ts
const v = validatePostReviewBody(request.body);
if (!v.ok) return reply.badRequest(v.message);
const body = v.value;
// ... transaction logic unchanged
```

Note the `Body: PostBody` type annotation on the handler became `Body:
unknown` because the validator now narrows from arbitrary input — the
previous typed annotation was a lie (Fastify does not enforce it without
a JSON schema, and the validator was already treating it as untrusted).

The `PostBody`/`FindingInput` types tightened slightly: `verdict: Verdict`
and `severity: Severity` instead of `string`, since the validator narrows
to those enums before returning.

Per the brief, kept all helpers in `reviews.ts` rather than splitting into
a `reviews-validation.ts` file — the file lands at 432 lines, comfortably
under the ~450 threshold.

### Files

- `server/src/routes/_route-helpers.ts` (new, 119 lines) — shared helpers.
- `server/src/routes/failures.ts` (modified) — 103 → 75 lines. Imports
  helpers; deletes local `DEFAULT_SINCE_MS`, `parseSince`,
  `normalizeIdArray`; uses `parseSinceParam` and `rowsOf`.
- `server/src/routes/findings.ts` (modified) — 337 → 297 lines. Imports
  helpers; deletes local `DEFAULT_SINCE_MS`, `parseSince`,
  `normalizeIdArray`, `REVIEWER_ROLE_RE`, `REVIEWER_ROLE_MAX`; uses
  `parseSinceParam`, `reviewerRoleError`, and `rowsOf`. The 12-line
  inline reviewer-validation block collapses to 4 lines.
- `server/src/routes/reviews.ts` (modified) — 366 → 432 lines. Imports
  `reviewerRoleError`. The 88-line inline validation lives in two
  pure helpers (`validatePostReviewBody`, `validateFinding`) at the top
  of the file; the handler body is reduced to a 3-line dispatch. Net
  growth (+66 lines) reflects the validator's structured-result
  scaffolding (tagged-union returns, explicit type narrowing); the
  handler itself is dramatically shorter.

The test files (`reviews.test.ts`, `findings.test.ts`,
`failures.test.ts`) are unchanged.

### Build & test results (cycle 4)

- `npm run typecheck` — clean.
- `npm run build` — clean.
- `npx tsx --test src/routes/reviews.test.ts src/routes/findings.test.ts
  src/routes/failures.test.ts` — 60/60 pass (29 + 25 + 6).
- `npm test` (full server suite) — 673/727 pass; 54 fails. Pass and
  fail counts unchanged from cycle 3. Same 54 environmental
  `Author identity unknown / Run git config --global user.email`
  failures in `agents.test.ts`, `projects.test.ts`,
  `tasks-deps.test.ts`, `tasks.test.ts` — none in the files this
  cycle touched.

### Open questions / risks

- The `Body: unknown` switch on the POST handler is a typing-honesty
  improvement (previously `Body: PostBody` was a lie — Fastify does not
  validate the body shape without a JSON schema, so the type was untrustworthy
  anyway). The validator now establishes the narrowing instead.
- `parseLimit` exists only in `findings.ts`; `failures.ts` does not have
  a `limit` query param, so it does not need the helper. Left in place
  to avoid scope expansion. If a future endpoint adopts `limit`, the
  helper should be promoted into `_route-helpers.ts` at that time.
