# Task FSM Drill-down + Operator Override

## Goal

Make the server-managed task FSM fully visible and recoverable from the dashboard.

**Drill-down**: a stranger landing on the [TaskDetailPage](../dashboard/src/pages/TaskDetailPage.tsx) should be able to
read the complete story of a task — every state transition with timestamp and actor, every engineer attempt's debrief,
every review cycle's verdicts and findings, every arbitration ruling — without ever opening the database.

**Operator override**: when the FSM stalls in a state the container cannot exit from (e.g. orphaned `arbitrating` after
an arbitrator container crash, `failed` after the operator fixed the underlying cause, `claimed` by a deleted agent),
the operator can `PATCH /tasks/:id` to set any field directly — bypassing the FSM transition table but still gated by
the database CHECK constraints — and the override is recorded in the audit log alongside organic transitions.

## Context

Existing surface to build on, **not** replace:

- [`dashboard/src/pages/TaskDetailPage.tsx`](../dashboard/src/pages/TaskDetailPage.tsx) already mounts [
  `TaskFsmStrip`](../dashboard/src/components/TaskFsmStrip.tsx), [
  `TaskArbitrationSection`](../dashboard/src/components/TaskArbitrationSection.tsx), and [
  `TaskReviewsSection`](../dashboard/src/components/TaskReviewsSection.tsx). The new drill-down sections sit alongside
  them.
- [`server/src/routes/tasks-lifecycle.ts`](../server/src/routes/tasks-lifecycle.ts) owns the FSM transition table at
  lines 111–123 and the `handleTransition` body that gates every container-driven state change. The new override path is
  a sibling route, not a flag on `/transition`.
- [`server/src/queries/tasks-lifecycle.ts::applyTransition`](../server/src/queries/tasks-lifecycle.ts) is the single
  write point for FSM status updates. Every other state-mutating query (`claim`, `release`, `reset`, `integrate`,
  `integrateBatch`, `integrateAll`, `releaseByAgent`, `releaseAllActive`) lives in the same file. Audit instrumentation
  lands in this file once, not in route handlers.
- The container side (`container/lib/pump-loop.sh`, `container/lib/engineer-dispatch.sh`,
  `container/lib/reviewer-fanout.sh`, `container/lib/arbitrator-dispatch.sh`) is unchanged for the audit log work — the
  server records audit rows when it processes the transitions the container already POSTs. Only Phase 6 touches the
  container (to start emitting debriefs).
- Reviewer markdown and arbitration markdown are already persisted to the DB (`reviewRuns.rawMarkdown`,
  `arbitrationRuns.rulingMarkdown`). Engineer debrief markdown is the symmetric gap.

Out of scope:

- Cleaning up `tasks.latestReviewPath` and `tasks.arbitrationAddendumPath`. Both are session-scoped working state
  living in the durable row — example value `/workspace/.scratch/reviews/6/cycle-0/consolidated.md` dies with the
  container that wrote it. Neither is a substantive durable artifact today, and arbitration hasn't fired in production
  yet so the addendum column is empty. Their cleanup is a separate concern from this plan; for that reason they are
  also intentionally absent from the operator override surface in Phase 5 and Phase 8.
- Per-role permission control on the override endpoint. The dashboard already runs unauthenticated against a localhost
  server (see [`CLAUDE.md`](../CLAUDE.md) — "designed to be accessed only by local Docker containers and the operator's
  dashboard"). Any operator with dashboard access can override.
- Adding a soft-revert path. The override is a forward-only mutation; if the operator picks the wrong target status,
  they `PATCH` again.

Canonical fact carried through every phase: **the database CHECK constraints are the final gate on legal values**. The
override endpoint does app-side validation as a fast path for a clear 422, but the database is authoritative — a CHECK
violation must surface as a 422 to the operator, never a 500.

<!-- PHASE-BOUNDARY -->

## Phase 1: Add `task_debriefs` and `task_state_changes` tables

**Outcome:** Running `npm run db:migrate` against a fresh PGlite database creates two new tables with CHECK constraints.
`npx tsx --test server/src/schema/tables.test.ts` (or the equivalent new test) passes; inserting a row that violates any
CHECK fails with a Postgres error mentioning the constraint name.

**Types / APIs:**

New Drizzle table definitions in [`server/src/schema/tables.ts`](../server/src/schema/tables.ts), placed below
`reviewFindings` to keep all task-attempt tables grouped:

```ts
export const taskDebriefs = pgTable(
    "task_debriefs",
    {
        id: serial("id").primaryKey(),
        taskId: integer("task_id")
            .notNull()
            .references(() => tasks.id, {onDelete: "cascade"}),
        cycle: integer("cycle").notNull(),
        role: text("role").notNull(),
        emittedOnTransition: text("emitted_on_transition").notNull(),
        markdown: text("markdown").notNull(),
        idempotencyKey: text("idempotency_key"),
        postedAt: timestamp("posted_at", {withTimezone: true})
            .notNull()
            .defaultNow(),
    },
    (table) => [
        check(
            "task_debriefs_role_check",
            sql`${table.role} IN ('engineer','arbitrator')`,
        ),
        check(
            "task_debriefs_transition_check",
            sql`${table.emittedOnTransition} IN ('built','arbitrating','failed','revising','completed')`,
        ),
        index("idx_task_debriefs_task_cycle").on(table.taskId, table.cycle),
        uniqueIndex("uniq_task_debriefs_task_idempotency")
            .on(table.taskId, table.idempotencyKey)
            .where(sql`${table.idempotencyKey} IS NOT NULL`),
    ],
);

export const taskStateChanges = pgTable(
    "task_state_changes",
    {
        id: serial("id").primaryKey(),
        taskId: integer("task_id")
            .notNull()
            .references(() => tasks.id, {onDelete: "cascade"}),
        fromStatus: text("from_status"),
        toStatus: text("to_status").notNull(),
        actorType: text("actor_type").notNull(),
        actorId: text("actor_id"),
        reason: text("reason"),
        payload: jsonb("payload"),
        isOverride: boolean("is_override").notNull().default(false),
        occurredAt: timestamp("occurred_at", {withTimezone: true})
            .notNull()
            .defaultNow(),
    },
    (table) => [
        check(
            "task_state_changes_actor_type_check",
            sql`${table.actorType} IN ('agent','operator','system')`,
        ),
        check(
            "task_state_changes_to_status_check",
            sql`${table.toStatus} IN ('pending','claimed','engineering','built','reviewing','revising','arbitrating','completed','failed','integrated','cycle')`,
        ),
        check(
            "task_state_changes_from_status_check",
            sql`${table.fromStatus} IS NULL OR ${table.fromStatus} IN ('pending','claimed','engineering','built','reviewing','revising','arbitrating','completed','failed','integrated','cycle')`,
        ),
        check(
            "task_state_changes_override_reason_check",
            sql`(${table.isOverride} = false) OR (${table.reason} IS NOT NULL AND length(${table.reason}) > 0)`,
        ),
        index("idx_task_state_changes_task_occurred").on(
            table.taskId,
            table.occurredAt,
        ),
    ],
);
```

The status enum is duplicated verbatim from [
`tasks_status_check`](../server/drizzle/0009_rename_complete_to_completed.sql) — when that enum changes, both checks
change together. Add a CODEOWNERS-style comment above each new check pointing to `tasks_status_check` as the canonical
source.

The `task_state_changes_override_reason_check` is the load-bearing audit invariant: an operator override row that lacks
a reason is a corruption — the operator must explain *why* they bypassed the FSM. Organic transitions (
`is_override = false`) can have a NULL reason.

The `role` enum on `task_debriefs` includes `arbitrator` for symmetry; Phase 6 only wires the engineer path. The
arbitrator's structured ruling already lands as `arbitrationRuns.rulingMarkdown`, so an arbitrator debrief row is
reserved for future process-level reflection rather than wired here.

The `idempotency_key` column plus the partial unique index `uniq_task_debriefs_task_idempotency` is the migration
hinge for [the future engineer-direct-post flow](#future-direction--engineer-posts-debriefs-directly). When a client
supplies an `Idempotency-Key` header, the server upserts on `(task_id, idempotency_key)` — duplicate posts (from both
the container wrapper and the engineer agent during a mixed-mode rollout) collapse to one row. When the header is
absent, the column is NULL and the partial index ignores the row, so legacy / future unkeyed inserts still work as a
plain insert. The column is nullable because the safety net (Phase 2 endpoint also accepting an unkeyed call) and
forward-compatibility (a future caller that doesn't yet know the key shape) both want the relaxed write path.

**Work:**

- Add the two table definitions in [`server/src/schema/tables.ts`](../server/src/schema/tables.ts) following the
  existing import/style of `reviewRuns`, `arbitrationRuns`, and `reviewFindings`.
- Generate the migration with `npx drizzle-kit generate` (writes `server/drizzle/0010_<random_name>.sql`). Inspect the
  generated SQL: the CHECK names must match what's declared above; the `uniq_task_debriefs_task_idempotency` partial
  unique index must include the `WHERE idempotency_key IS NOT NULL` predicate (drizzle-kit's partial-index emission has
  been imperfect in older versions — if the predicate is missing, hand-edit the generated SQL). Hand-rename the
  migration file if drizzle-kit picks a poor slug — `0010_task_debriefs_and_state_changes.sql` is the target.
- Add a `tables.test.ts` (or extend an existing schema smoke test) that asserts: each CHECK rejects an out-of-enum value
  with the expected constraint name; the `task_state_changes_override_reason_check` rejects
  `(is_override=true, reason=null)` and accepts `(is_override=true, reason='unstuck arbitration')`; the partial unique
  index `uniq_task_debriefs_task_idempotency` rejects a second insert with the same `(task_id, idempotency_key)` and
  admits two inserts with `idempotency_key=NULL` for the same task.

**Verification:**

- `cd server && npm run db:migrate` against a fresh PGlite db succeeds.
- `cd server && npx tsx --test src/schema/tables.test.ts` passes (CHECK rejection tests).
- `cd server && npm run typecheck` passes (drizzle inference picks up the new tables).

<!-- PHASE-BOUNDARY -->

## Phase 2: Server query helpers and route for task debriefs

**Outcome:** A container can `POST /tasks/:id/debriefs` with a markdown body and the row lands in `task_debriefs`. A
dashboard can `GET /tasks/:id/debriefs` and receive every debrief for the task, oldest-first within each cycle, sorted
by cycle ascending.

**Types / APIs:**

New file [`server/src/queries/task-debriefs.ts`](../server/src/queries/task-debriefs.ts):

```ts
export interface TaskDebriefRow {
    id: number;
    taskId: number;
    cycle: number;
    role: "engineer" | "arbitrator";
    emittedOnTransition: string;
    markdown: string;
    idempotencyKey: string | null;
    postedAt: Date;
}

/**
 * Insert a debrief. When `idempotencyKey` is supplied and a row already exists
 * for `(taskId, idempotencyKey)`, returns the existing row with `deduped: true`
 * and performs no write. When `idempotencyKey` is absent, always inserts.
 */
export async function insertDebrief(
    db: DrizzleDb | DbOrTx,
    args: {
        taskId: number;
        cycle: number;
        role: "engineer" | "arbitrator";
        emittedOnTransition: string;
        markdown: string;
        idempotencyKey?: string;
    },
): Promise<{row: TaskDebriefRow; deduped: boolean}>;

export async function listForTask(
    db: DrizzleDb,
    taskId: number,
): Promise<TaskDebriefRow[]>;
```

`listForTask` returns rows ordered by `(cycle ASC, posted_at ASC)` so the dashboard renders the timeline naturally.

New file [`server/src/routes/task-debriefs.ts`](../server/src/routes/task-debriefs.ts) exporting a
`FastifyPluginAsync<TasksOpts>`:

- `POST /tasks/:id/debriefs` — body
  `{ cycle: number, role: 'engineer' | 'arbitrator', emittedOnTransition: string, markdown: string }`. Validates: task
  exists; `projectId` matches header; cycle is a non-negative integer; `role` is in the enum; `emittedOnTransition` is
  in the enum from the CHECK; markdown is a non-empty string ≤ 1 MiB. The endpoint also reads the optional
  `Idempotency-Key` HTTP header (when present, value ≤ 256 chars, matches `/^[A-Za-z0-9._-]+$/`) and passes it through
  to `insertDebrief`. Response shape: `{ row: TaskDebriefRow, deduped: boolean }`. A deduped hit returns 200 with
  `deduped: true` and the existing row — never 409, because the caller's intent (a debrief for this attempt exists)
  has already been satisfied.
- `GET /tasks/:id/debriefs` — returns `{ debriefs: TaskDebriefRow[] }`. 404 if task not found in the request's project.

The route is registered alongside the other task plugins inside [
`server/src/routes/tasks.ts`](../server/src/routes/tasks.ts) (or wherever the umbrella registers `tasks-lifecycle`,
`tasks-claim`, `reviews`, `arbitrations` — follow that file's existing pattern exactly).

The 1 MiB markdown cap mirrors the implicit cap on `reviewRuns.rawMarkdown` and `arbitrationRuns.rulingMarkdown` (which
are unbounded today — flag this as a follow-up, but do not introduce a cap on those columns in this plan).

**Work:**

- Write [`server/src/queries/task-debriefs.ts`](../server/src/queries/task-debriefs.ts).
- Write [`server/src/routes/task-debriefs.ts`](../server/src/routes/task-debriefs.ts).
- Register the plugin in the same place that registers `reviews.ts` and `arbitrations.ts` (grep for
  `import reviews from`).
- Write [`server/src/routes/task-debriefs.test.ts`](../server/src/routes/task-debriefs.test.ts) covering: insert success
  returns 200 + row + `deduped: false`; missing/oversized markdown returns 400; unknown task or wrong project returns
  404; out-of-enum role returns 400; list returns rows ordered by `(cycle, postedAt)`; CHECK constraint violation on
  `emittedOnTransition` returns 400 (app-side) — never 500; **idempotency** — two POSTs with the same
  `Idempotency-Key` return the same row id, the second with `deduped: true`; two POSTs without the header insert two
  separate rows for the same task; an `Idempotency-Key` value that violates the regex/length cap returns 400.

**Verification:**

- `cd server && npx tsx --test src/routes/task-debriefs.test.ts` passes.
- `cd server && npm test` passes (regression sweep — the umbrella registration touches surface used by other route
  tests).

<!-- PHASE-BOUNDARY -->

## Phase 3: Audit-log every server-side FSM transition

**Outcome:** Every successful state mutation in [
`server/src/queries/tasks-lifecycle.ts`](../server/src/queries/tasks-lifecycle.ts) — `claim`, `release`, `reset`,
`integrate`, `integrateBatch`, `integrateAll`, `applyTransition`, `releaseByAgent`, `releaseAllActive` — writes a
`task_state_changes` row in the same transaction as the `tasks` update. A task that goes pending → claimed →
engineering → built → reviewing → completed produces six audit rows in `(occurred_at ASC)` order.

**Types / APIs:**

Extend [`server/src/queries/tasks-lifecycle.ts`](../server/src/queries/tasks-lifecycle.ts) with a private helper:

```ts
async function recordStateChange(
    tx: DbOrTx,
    args: {
        taskId: number;
        fromStatus: string | null;
        toStatus: string;
        actorType: "agent" | "operator" | "system";
        actorId: string | null;
        reason: string | null;
        payload: unknown;
        isOverride: boolean;
    },
): Promise<void>;
```

Each public query function wraps its `db.update(tasks)...` call in a `db.transaction(async (tx) => { ... })` block (
drizzle's interface), runs the update, and on a non-empty returning set calls `recordStateChange(tx, ...)`. The audit
row is written with the `from_status` read from the `returning()` of the *old* state — to capture the actual fromStatus
we read it before the update and pass it through, since `returning()` gives the post-update row.

To capture `fromStatus` cleanly without a SELECT-then-UPDATE race, switch each update to a single statement that reads
the prior status using a CTE:

```sql
WITH prev AS (SELECT status FROM tasks WHERE id = $1 AND project_id = $2 AND status = $expected
    FOR UPDATE )
UPDATE tasks
SET status = $next, ...WHERE id = $1 AND project_id = $2 AND status = $expected
    RETURNING (SELECT status FROM prev) AS from_status, *;
```

If a CTE turns out awkward in drizzle's query builder, the alternative is a `SELECT ... FOR UPDATE` then `UPDATE` inside
the same transaction — both are correct, the CTE is preferred for atomicity in a single round-trip. Pick one and apply
it consistently across all six callers.

`actorType` and `actorId` are derived per caller:

| Query                                           | actorType  | actorId                                                                                                                        |
|-------------------------------------------------|------------|--------------------------------------------------------------------------------------------------------------------------------|
| `claim`                                         | `agent`    | `agentId` arg                                                                                                                  |
| `release`                                       | `system`   | `null` (no agent identity at the call site)                                                                                    |
| `reset`                                         | `operator` | `null`                                                                                                                         |
| `integrate` / `integrateBatch` / `integrateAll` | `operator` | `null`                                                                                                                         |
| `applyTransition`                               | `agent`    | new arg `actorAgentId: string \| null` threaded from the route, taken from `X-Agent-Name` header → looked up by `resolveAgent` |
| `releaseByAgent` / `releaseAllActive`           | `system`   | `null`                                                                                                                         |

The new `actorAgentId` argument on `applyTransition` is non-breaking because all callers live in this repo —
`handleTransition` in [`tasks-lifecycle.ts`](../server/src/routes/tasks-lifecycle.ts) is the only caller. It resolves
the agent via the existing `inject-agent-header.sh`-set `X-Agent-Name` header. If the header is absent (legacy call),
pass `null` and the audit row records `actorType='agent', actorId=null`.

`payload` is the transition body (`TransitionBody.payload` for `applyTransition`, the relevant arg for the others —
`{ agentId }` for `claim`, `{}` for `release`, etc.) serialized as JSONB. This is the forensic anchor: the operator
looking at a failed transition can see what the container actually sent.

`isOverride` is always `false` for these callers — Phase 5 is the only writer that flips it to `true`.

**Work:**

- Add `recordStateChange` to [`server/src/queries/tasks-lifecycle.ts`](../server/src/queries/tasks-lifecycle.ts).
- Wrap every public mutator in this file in a transaction and call `recordStateChange` on the success branch (
  `rows.length > 0`).
- Thread `actorAgentId` through `applyTransition` and the route call site in `handleTransition`.
- Thread `actorAgentId` through `claim` if it isn't already — it takes `agentId` so this is free.
- For `integrateBatch` and `integrateAll`, write one audit row *per task id* in `ids`, not one row for the whole batch.
  Same `occurred_at` is fine — the rows differ by `task_id`.
- Add `recordStateChange` calls to the corresponding test setup if any existing test asserts the absence of unrelated
  rows (none should, but check).

**Verification:**

- `cd server && npx tsx --test src/queries/tasks-lifecycle.test.ts` passes (existing tests should still pass — the audit
  row is additive).
- New test [`server/src/queries/tasks-lifecycle.audit.test.ts`](../server/src/queries/tasks-lifecycle.audit.test.ts):
  for each public mutator, exercise the success path and assert a matching `task_state_changes` row exists with the
  right `from_status`, `to_status`, `actor_type`, `actor_id`, `payload`, and `is_override=false`. Also exercise the
  failure path (e.g. `release` on an `engineering` task) and assert no audit row was written.
- `cd server && npm test` passes end-to-end.

<!-- PHASE-BOUNDARY -->

## Phase 4: Server endpoint to read the state-change timeline

**Outcome:** `GET /tasks/:id/state-changes` returns the audit rows for a task in chronological order. The dashboard can
render a vertical timeline of every state change with actor, reason, and the JSON payload that drove the transition.

**Types / APIs:**

New file [`server/src/queries/task-state-changes.ts`](../server/src/queries/task-state-changes.ts):

```ts
export interface TaskStateChangeRow {
    id: number;
    taskId: number;
    fromStatus: string | null;
    toStatus: string;
    actorType: "agent" | "operator" | "system";
    actorId: string | null;
    reason: string | null;
    payload: unknown;
    isOverride: boolean;
    occurredAt: Date;
}

export async function listForTask(
    db: DrizzleDb,
    taskId: number,
): Promise<TaskStateChangeRow[]>;
```

Ordering: `(occurred_at ASC, id ASC)` — the secondary sort on `id` is the tiebreaker for two transitions that share a
timestamp (PGlite's `now()` resolution is microsecond, Postgres can collide).

New route in [`server/src/routes/task-state-changes.ts`](../server/src/routes/task-state-changes.ts) exporting a
`FastifyPluginAsync<TasksOpts>`:

- `GET /tasks/:id/state-changes` — returns `{ changes: TaskStateChangeRow[] }`. 404 if task not found in project. No
  pagination (a task with > 100 state changes is itself a bug worth seeing).

Register alongside the existing task plugins.

**Work:**

- Write [`server/src/queries/task-state-changes.ts`](../server/src/queries/task-state-changes.ts).
- Write [`server/src/routes/task-state-changes.ts`](../server/src/routes/task-state-changes.ts).
- Register the plugin in the same umbrella that registers `reviews.ts`, `arbitrations.ts`, and the Phase 2 debriefs
  plugin.
- Write [`server/src/routes/task-state-changes.test.ts`](../server/src/routes/task-state-changes.test.ts) covering:
  empty list on a brand-new task; chronological order across mixed claim / release / transition history; 404 on unknown
  task; project isolation (a task in project A is not returned to project B).

**Verification:**

- `cd server && npx tsx --test src/routes/task-state-changes.test.ts` passes.
- `cd server && npm test` passes.

<!-- PHASE-BOUNDARY -->

## Phase 5: Operator override endpoint — `PATCH /tasks/:id`

**Outcome:** An operator can `PATCH /tasks/:id` with a body that includes any subset of the override-eligible fields
plus a required `reason` string, and the task row is updated in a single transaction with an audit row recording the
change. The endpoint bypasses the FSM transition table (so `failed → engineering` is legal) but validates every field's
value against the same enum allowlists the CHECK constraints enforce, returning a 422 for any out-of-enum value rather
than letting the DB raise a constraint error as a 500.

**Types / APIs:**

New section in [`server/src/routes/tasks-lifecycle.ts`](../server/src/routes/tasks-lifecycle.ts) (or new file [
`server/src/routes/tasks-override.ts`](../server/src/routes/tasks-override.ts) if the lifecycle file is getting
unwieldy — author's call; the existing reviewer/builder enum imports already sit in `tasks-lifecycle.ts`, so colocating
is the natural choice unless the file exceeds ~900 lines).

```ts
interface OverridePatchBody {
    reason: string; // required, non-empty, ≤ 4096 chars
    status?: FsmStatus;
    buildStatus?: "pending" | "clean" | "dirty" | "failed";
    failureReason?: FailureReason | null;
    failureDetail?: string | null;
    arbitrationPendingTrigger?: ArbitrationTrigger | null;
    reviewCycleCount?: number;          // ≥ 0
    reviewCycleBudget?: number;         // ≥ 1
    reviewerVerdicts?: Record<string, Verdict>; // each value in VERDICTS; keys must match REVIEWER_ROLE_RE
    claimedByAgentId?: string | null;   // when not null, must resolve to an existing agent in the project
    completedAt?: string | null;        // ISO-8601 or null
    commitSha?: string | null;
}
```

Validation rules — every present field is checked against the canonical enum allowlist (the same constants already
declared at the top of `tasks-lifecycle.ts`: `FAILURE_REASONS`, `ARBITRATION_TRIGGERS`, `BUILD_STATUSES`, `VERDICTS`).
The `FsmStatus` allowlist is the 11-value status union. Any out-of-enum value returns 422 with a message that quotes the
legal set.

`reason` is required and ≥ 1 character — this enforces the audit invariant (`task_state_changes_override_reason_check`)
at the application layer before the SQL ever runs.

Body must contain at least one mutating field besides `reason` — otherwise 400. The endpoint is for changes; a no-op
PATCH is a client error.

Route shape:

- `PATCH /tasks/:id` — body `OverridePatchBody`. 404 if task not in project. 422 on any invalid field value with the
  field name and the legal set in the error message. 200 on success returning the updated `Task`.

The single transaction body:

1. `SELECT ... FOR UPDATE` the task by `(id, projectId)`.
2. Build the `SET` clause from the body (only fields actually present in the body).
3. If `claimedByAgentId` is non-null, resolve via `resolveAgent` and 422 if unknown.
4. `UPDATE tasks SET ... WHERE id = $id AND project_id = $projectId RETURNING *`.
5. Call
   `recordStateChange(tx, { taskId, fromStatus: priorStatus, toStatus: row.status, actorType: 'operator', actorId: null, reason, payload: body, isOverride: true })`.
6. Return the updated row.

If the body did not mutate `status`, `fromStatus` still equals `toStatus` in the audit row — that's correct: the
override only changed auxiliary fields, but it's still an override worth auditing.

DB CHECK violation handling: wrap the UPDATE in a try/catch; on a `code: '23514'` (Postgres check_violation), translate
to a 422 with the constraint name in the message. This is the safety net for any path the app-side allowlist missed.

**Work:**

- Implement the validator: factor out a
  `validateOverridePatch(body): { ok: true, patch: ... } | { ok: false, error: string }` so the route handler stays
  linear.
- Implement the route. Use a transaction; the read-then-update pattern is the same as Phase 3 (use the same CTE or
  `SELECT FOR UPDATE` shape, whichever Phase 3 chose).
- Pass the override row through `recordStateChange` with `isOverride: true` and the operator's `reason`.
- Write [`server/src/routes/tasks-override.test.ts`](../server/src/routes/tasks-override.test.ts) covering: forward-only
  happy path (`failed → engineering` with `reason='reproducer fixed'`); auxiliary-only patch (no status change, clears
  `arbitrationPendingTrigger`, audit row with `from_status === to_status`); missing reason → 400; out-of-enum
  `failureReason` → 422; out-of-enum `status` → 422; unknown `claimedByAgentId` → 422; unknown task → 404; project
  isolation (PATCH against task in project A from project B → 404); audit row written with `is_override=true` and the
  full body as `payload`; **CHECK constraint translation test** — inject a value that passes the app validator but the
  DB rejects (or strip the app validator to confirm the catch path returns 422 not 500).

**Verification:**

- `cd server && npx tsx --test src/routes/tasks-override.test.ts` passes.
- `cd server && npm test` passes (no regressions in the rest of the task surface).

<!-- PHASE-BOUNDARY -->

## Phase 6: Container engineer-session emits debriefs on transition (transitional bridge)

**Outcome:** When the engineer role session completes and POSTs `engineering → built`, `engineering → arbitrating`, or
`engineering → failed` to `/tasks/:id/transition`, the dispatch wrapper also POSTs the engineer's final summary as a
debrief to `/tasks/:id/debriefs` so the dashboard can render the engineer's narrative alongside the structured FSM
data. A debrief POST that fails (server unreachable, 4xx, etc.) does not block the transition — debriefs are
best-effort.

This phase is a transitional bridge, not the steady state. The intended end state — described in
[the future-direction section at the end of this plan](#future-direction--engineer-posts-debriefs-directly) — is that
the engineer agent itself POSTs its debrief, with no wrapper involvement. The wrapper exists now because no current
engineer agent definition instructs the engineer to call the endpoint; once that changes, this wrapper code is
deleted. The `Idempotency-Key` header (see Phase 2) protects the cutover: during any window where both the wrapper
and the engineer post, the second post collapses into the first via the partial unique index on
`(task_id, idempotency_key)`.

**Types / APIs:**

In [`container/lib/engineer-dispatch.sh`](../container/lib/engineer-dispatch.sh) (or whichever script wraps the engineer
`claude -p` invocation — verify the actual filename in the current branch; engineer-dispatch is the canonical name from
Phase 5 of the FSM plan):

- After the engineer `claude -p` session exits with output captured into a transcript file, parse the last message of
  the assistant transcript (the engineer's final summary). The exact extraction rule:
    - The engineer session writes its transcript to a per-session file under the container's scratch directory (e.g.
      `.scratch/engineer-<taskId>-<cycle>.jsonl`).
    - Read the last `assistant` event's `message.content[0].text` field with `jq` — this is the engineer's final summary
      directed at the next role.
    - If the field is absent (engineer session crashed before producing output), emit a placeholder debrief:
      `_(no engineer summary captured)_` rather than skipping the POST.
- Before POSTing the transition, POST the debrief:
    - Use the existing `inject-agent-header.sh`-augmented `curl` helper.
    - Endpoint: `POST $SERVER_URL/tasks/$TASK_ID/debriefs`.
    - Header: `Idempotency-Key: <task_id>-<cycle>-<session_uuid>`, where `session_uuid` is the
      `claudeCodeContainerSessions.id` UUID created when the dispatch wrapper inserted the role-session row before
      spawning `claude -p`. The wrapper already owns this id; export it as `ROLE_SESSION_UUID` (or read it back from
      whatever variable holds it today) and concatenate. Engineers in the future-direction flow will use the same
      derivation, so the dedup matches across both posters.
    - Body (built with `jq` to a temp file per [
      `feedback_shell_json_encoding`](../C:/Users/thele/.claude/projects/D--coding-ue-claude-scaffold/memory/feedback_shell_json_encoding.md)):
      ```json
      {
        "cycle": <current cycle>,
        "role": "engineer",
        "emittedOnTransition": "<built|arbitrating|failed>",
        "markdown": "<last assistant message>"
      }
      ```
    - Curl flags: short connect timeout (~5s), short total timeout (~30s — the markdown can be sizeable), no retry. If
      the POST fails (curl exit ≠ 0 or HTTP ≥ 400), log a warning to stderr and continue.
- Continue with the existing `/transition` POST regardless of the debrief outcome.

The cycle number passed in `cycle` is the task's `reviewCycleCount` *at the time the engineer session started* — capture
it at session entry, not at session exit. This matters because if the engineer transitions to `arbitrating` (which on
the reroute path inside `handleTransition` may bump `reviewCycleCount`), the debrief belongs to the cycle that the
engineer worked under.

**Worked example** of cycle attribution:

- Task is in `revising` at cycle 2 (`reviewCycleCount = 2`).
- Container claims, kicks off engineer for cycle 2's revision pass.
- Engineer captures `cycle=2` at session start.
- Engineer finishes, POSTs debrief with `cycle: 2`.
- Engineer POSTs `engineering → built` transition.
- Server records debrief in cycle 2 (the cycle the engineer actually worked on).

If instead the engineer POSTs `engineering → arbitrating`, no review cycle bump happens — the debrief is still cycle 2.

**Work:**

- Locate the engineer dispatch script: `grep -l "claude -p" container/lib/`. Likely `engineer-dispatch.sh` per the
  durable-FSM plan's phase-5 wiring. If the filename differs, adapt — the script is the one that owns the engineer role
  invocation.
- Add a `_capture_engineer_summary` shell function that reads the transcript and emits the markdown to stdout (or a
  placeholder).
- Add a `_post_engineer_debrief` shell function that builds the JSON body via `jq` into a temp file, derives the
  `Idempotency-Key` from `${TASK_ID}-${CYCLE}-${ROLE_SESSION_UUID}`, and POSTs with `curl -H "Idempotency-Key: ..."`,
  swallowing errors.
- Call `_post_engineer_debrief` immediately before the existing `/transition` POST.
- The placement should be inside the existing exit-success branch only — if the engineer hit a non-recoverable error
  before reaching the transition, no debrief is posted (the abnormal-exit path in [
  `container/lib/registration.sh`](../container/lib/registration.sh) handles task release; debriefs require a
  transition).

**Verification:**

- `cd server && npm run dev` against PGlite in one shell.
- Launch a container against a test task: `./launch.sh --worker --project default` (or whichever test project is set up
  locally).
- Watch the task move through `engineering → built` and then `built → reviewing`.
- `curl -H "X-Project-Id: default" http://localhost:9100/tasks/<id>/debriefs` and confirm a debrief row with
  `role: 'engineer'`, the right `cycle`, and the engineer's markdown summary.
- Manually break the server (`stop` the dev process), launch the container, confirm the transition still POSTs
  successfully once the server is up *or* the task lands in a state that can be retried — the debrief POST failure must
  not corrupt the workflow.
- **Operator verification**: per [
  `feedback_container_changes_need_operator_verification`](../C:/Users/thele/.claude/projects/D--coding-ue-claude-scaffold/memory/feedback_container_changes_need_operator_verification.md),
  this phase's acceptance requires a `./scripts/build-image.sh` rebuild + the smoke-test loop above run by the operator.
  The implementing agent cannot recurse Docker from inside a container.

<!-- PHASE-BOUNDARY -->

## Phase 7: Dashboard — debriefs and state-change timeline sections

**Outcome:** [`TaskDetailPage`](../dashboard/src/pages/TaskDetailPage.tsx) renders two new sections below the existing
`TaskReviewsSection`: `TaskDebriefsSection` (engineer narratives grouped by cycle) and `TaskStateChangesTimeline` (
vertical chronological log of every state change with actor and reason). Both poll on the standard `usePollInterval`.

**Types / APIs:**

Extend [`dashboard/src/api/types.ts`](../dashboard/src/api/types.ts):

```ts
export interface TaskDebrief {
    id: number;
    taskId: number;
    cycle: number;
    role: "engineer" | "arbitrator";
    emittedOnTransition: string;
    markdown: string;
    postedAt: string;
}

export interface TaskStateChange {
    id: number;
    taskId: number;
    fromStatus: string | null;
    toStatus: string;
    actorType: "agent" | "operator" | "system";
    actorId: string | null;
    reason: string | null;
    payload: unknown;
    isOverride: boolean;
    occurredAt: string;
}
```

Extend [`dashboard/src/api/client.ts`](../dashboard/src/api/client.ts):

```ts
export function fetchTaskDebriefs(
    taskId: number,
    signal: AbortSignal | undefined,
    projectId: string,
): Promise<{ debriefs: TaskDebrief[] }>;

export function fetchTaskStateChanges(
    taskId: number,
    signal: AbortSignal | undefined,
    projectId: string,
): Promise<{ changes: TaskStateChange[] }>;
```

New components:

- [`dashboard/src/components/TaskDebriefsSection.tsx`](../dashboard/src/components/TaskDebriefsSection.tsx) — props
  `{ taskId: number; projectId: string; currentCycle: number }`. Mirrors the structure of [
  `TaskReviewsSection`](../dashboard/src/components/TaskReviewsSection.tsx): cycles in descending order, current cycle
  highlighted; per debrief a card with a small `emittedOnTransition` badge (color-mapped:
  `built=blue, arbitrating=pink, failed=red, revising=orange, completed=green`) and the `MarkdownContent` body. Use the
  same `RelativeTime`, `MarkdownContent`, and `usePollInterval` primitives already in use across other sections.
- [`dashboard/src/components/TaskStateChangesTimeline.tsx`](../dashboard/src/components/TaskStateChangesTimeline.tsx) —
  props `{ taskId: number; projectId: string }`. Renders a Mantine `Timeline` (vertical, oldest at top, newest at
  bottom). Each `Timeline.Item` shows: the `fromStatus → toStatus` arrow using the existing [
  `StatusBadge`](../dashboard/src/components/StatusBadge.tsx) for both ends; an `actorType` icon (or text chip);
  `actorId` resolved to an agent name via the existing [`useAgentNameMap`](../dashboard/src/hooks/useAgentNameMap.ts)
  when `actorType === 'agent'`; a "manual override" badge in red when `isOverride === true`; a collapsible
  `<Code block>` of the `payload` JSON; the `reason` text when present.

The status pair rendering uses `StatusBadge` for `fromStatus` and `toStatus` separately rather than introducing a new "
transition badge" component — reusing the existing color map keeps the timeline visually coherent with the FSM strip
above.

**Work:**

- Extend [`dashboard/src/api/types.ts`](../dashboard/src/api/types.ts) and [
  `dashboard/src/api/client.ts`](../dashboard/src/api/client.ts).
- Write the two components following the existing component conventions exactly — same import order, same
  `Card withBorder p="md"` outer shell, same Title order=5 heading, same loading/error/empty pattern as [
  `TaskArbitrationSection`](../dashboard/src/components/TaskArbitrationSection.tsx).
- Mount both sections in [`TaskDetailPage`](../dashboard/src/pages/TaskDetailPage.tsx) below `TaskReviewsSection` —
  debriefs first, then timeline at the bottom (the timeline is reference data; the operator typically reads it last).
- Write Vitest unit tests [
  `dashboard/src/components/TaskDebriefsSection.test.tsx`](../dashboard/src/components/TaskDebriefsSection.test.tsx)
  and [
  `dashboard/src/components/TaskStateChangesTimeline.test.tsx`](../dashboard/src/components/TaskStateChangesTimeline.test.tsx)
  covering: empty state; multi-cycle ordering for debriefs; chronological ordering for timeline; the operator-override
  badge visibility; payload JSON expansion.

**Verification:**

- `cd dashboard && npm run lint` clean.
- `cd dashboard && npm test` passes.
- `cd dashboard && npm run build` succeeds (type-check + bundle).
- Manual smoke: `cd dashboard && npm run dev`; against a running server with a multi-cycle task, navigate to
  `/<projectId>/tasks/<id>` and confirm both new sections render with sensible content; force a state change via
  `POST /tasks/<id>/transition` and confirm the timeline picks it up within one poll interval.

<!-- PHASE-BOUNDARY -->

## Phase 8: Dashboard — operator override card

**Outcome:** [`TaskDetailPage`](../dashboard/src/pages/TaskDetailPage.tsx) renders a `TaskOperatorOverrideCard`
collapsed by default ("Operator override" heading + expand control). When expanded, the operator can edit any of the
override-eligible fields, supply a mandatory reason, click "Apply override", confirm in a popover, and the PATCH fires.
On success the task and timeline queries invalidate and the new state appears within the next poll. On failure (422,
404) the error surfaces as a Mantine notification with the server's message.

**Types / APIs:**

Extend [`dashboard/src/api/client.ts`](../dashboard/src/api/client.ts):

```ts
export function patchTaskOverride(
    taskId: number,
    body: OverridePatchBody,
    projectId: string,
): Promise<Task>;
```

Add `OverridePatchBody` to [`dashboard/src/api/types.ts`](../dashboard/src/api/types.ts), mirroring the server's
interface (Phase 5).

Extend [`dashboard/src/hooks/useTaskActions.ts`](../dashboard/src/hooks/useTaskActions.ts) with a new handler:

```ts
const handleOverride = async (id: number, body: OverridePatchBody) => {
    try {
        await patchTaskOverride(id, body, projectId);
        await queryClient.invalidateQueries({queryKey: ['tasks']});
        await queryClient.invalidateQueries({queryKey: ['task-state-changes', id]});
        notifications.show({title: 'Override applied', message: `Task #${id} updated`, color: 'green'});
    } catch (err) {
        notifications.show({title: 'Override failed', message: toErrorMessage(err), color: 'red'});
    }
};
```

Invalidate the `['tasks']` root key (not just the single task) because override may flip the task's eligibility in list
views (e.g. resetting `failed → engineering` removes it from a "failed only" filter).

New component [
`dashboard/src/components/TaskOperatorOverrideCard.tsx`](../dashboard/src/components/TaskOperatorOverrideCard.tsx) —
props `{ task: Task }`. Layout:

- Mantine `Card withBorder p="md"` with a `Collapse`-controlled body. Collapsed heading:
  `<Group><Title order={5}>Operator override</Title><Badge color="orange" variant="light">danger</Badge></Group>` — the
  danger badge is the cue that this is the manual-intervention surface.
- Expanded body, top-to-bottom:
    - **Reason** — required Mantine `<Textarea>`, the form's submit button stays disabled until reason has ≥ 1
      character.
    - **Status** — `<Select>` populated from the 11-value status enum; `clearable={true}` (leaving blank = don't
      change).
    - **Build status** — `<Select>` with the 4 values; clearable.
    - **Failure reason** — `<Select>` with the 6 values plus an explicit "(clear)" option that PATCHes `null`.
    - **Failure detail** — `<Textarea>`, with a "(clear)" checkbox that PATCHes `null` when ticked.
    - **Arbitration pending trigger** — `<Select>` with the 2 values plus "(clear)".
    - **Claimed by agent** — `<Select>` populated from `useAgentNameMap()`, plus "(clear)".
    - **Review cycle count / budget** — paired `<NumberInput>` with `min={0}` (count) and `min={1}` (budget).
    - **Reviewer verdicts** — read-only display of the current map (don't expose editing in the UI for v1; if a stuck
      cycle needs the verdict slate wiped, the operator flips `status` to `built` — the container's next reviewing
      entry re-enters with an empty verdict map per the existing built→reviewing reset in `handleTransition`).
- Submit button: `<Button color="orange" disabled={...}>Apply override</Button>`. On click, opens a Mantine `Popover`
  with a "This bypasses the FSM. Continue?" message and confirm/cancel buttons (mirrors the [
  `AgentsPanel`](../dashboard/src/components/AgentsPanel.tsx) delete-confirm pattern).
- On confirm, build the `OverridePatchBody` from the form state (only including fields the operator actually touched),
  call `handleOverride`, close the popover, reset the form on success.

The form state is intentionally local React state — no need for a form library; the shape is small and the validation is
server-side.

Layout placement in [`TaskDetailPage`](../dashboard/src/pages/TaskDetailPage.tsx): mount immediately after the
`TaskFsmStrip` (i.e. between strip and `TaskArbitrationSection`). This puts the override surface in the operator's
eyeline once they've read the FSM state and decided the task needs intervention, but keeps it above the deep history.

**Work:**

- Extend [`dashboard/src/api/types.ts`](../dashboard/src/api/types.ts) and [
  `dashboard/src/api/client.ts`](../dashboard/src/api/client.ts).
- Extend [`dashboard/src/hooks/useTaskActions.ts`](../dashboard/src/hooks/useTaskActions.ts) — note that the existing
  signature takes a lot of confirm-state setters; the override handler doesn't need that surface, so add it as a
  standalone export `useTaskOverride` rather than threading more state through `useTaskActions`. The two hooks can
  coexist; nothing forces consolidation.
- Write the override card component.
- Mount in `TaskDetailPage` per the placement above.
- Write [
  `dashboard/src/components/TaskOperatorOverrideCard.test.tsx`](../dashboard/src/components/TaskOperatorOverrideCard.test.tsx)
  covering: submit disabled without reason; selecting "(clear)" on a field results in `null` in the PATCH body; "Apply
  override" opens the confirmation popover; confirm fires the mutation; 422 error path surfaces a notification; success
  path invalidates queries.

**Verification:**

- `cd dashboard && npm run lint` clean.
- `cd dashboard && npm test` passes.
- `cd dashboard && npm run build` succeeds.
- Manual smoke: stall a task by leaving it in `arbitrating` with a `arbitrationPendingTrigger` set; from the dashboard,
  open the override card, PATCH `status: 'revising'` + clear `arbitrationPendingTrigger` + reason
  `'arbitrator container crashed; resuming revision manually'`; confirm the task transitions, the
  `TaskStateChangesTimeline` shows the operator override row (red "manual override" badge), and the container picks up
  the task again on its next pump loop.
- Manual smoke: stall a task in `failed` with `failureReason: 'engineer_build_failure'`; override with
  `status: 'engineering'`, clear `failureReason` and `failureDetail`, reason `'host build env fixed'`; confirm
  transition and audit row.

---

## Future direction — engineer posts debriefs directly

Phase 6 is the transitional bridge: the dispatch wrapper extracts the engineer's final summary from the transcript
and posts it. The intended end state is that the engineer agent itself calls `POST /tasks/:id/debriefs` as part of
its session, removing the wrapper step entirely — the engineer's narrative never touches the container filesystem or
the agent's git branch.

The endpoint shape is already designed for this. `{cycle, role, emittedOnTransition, markdown}` are all values the
engineer knows at session end: `role` from its own identity, `cycle` from the task row it's working on,
`emittedOnTransition` from the transition it's about to POST, `markdown` from its own final summary. The
`inject-agent-header.sh` hook sets `X-Agent-Name` / `X-Project-Id` on every outbound `curl` regardless of which
process inside the container makes the call, so authentication and project scoping are unchanged.

The `Idempotency-Key` header is the migration tool. Both the wrapper and the engineer derive the same key shape —
`<task_id>-<cycle>-<role_session_uuid>` — so during a mixed-mode rollout where one project's engineer agent
definition has been updated but another hasn't, duplicate posts collapse to a single row via the partial unique
index on `(task_id, idempotency_key)` instead of accumulating.

Retirement trigger: when [`dynamic-agents/container-implementer.md`](../dynamic-agents/container-implementer.md) (or
the equivalent compiled engineer definition that the `engineer` role resolves to) instructs the engineer to POST its
own debrief before transitioning, the wrapper's `_post_engineer_debrief` call in
[`container/lib/engineer-dispatch.sh`](../container/lib/engineer-dispatch.sh) is deleted in a follow-up. No DB
migration. No endpoint change. The wrapper code is the only thing that goes away.
