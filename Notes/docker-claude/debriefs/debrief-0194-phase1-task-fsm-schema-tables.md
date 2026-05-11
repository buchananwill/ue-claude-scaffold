# Debrief 0194 — Phase 1: Schema migration (task FSM columns and review tables)

## Task Summary

Implement Phase 1 of the durable-task-FSM-and-parallel-role-sessions plan:
declare the new task FSM shape and the new review/arbitration tables in
`server/src/schema/tables.ts`. Hard constraint from the plan: this is a
source-code-only phase — only `tables.ts` may be modified, no migration files
are generated, `migrate.ts` is untouched.

Plan file:
`/workspace/plans/durable-task-fsm-and-parallel-role-sessions/phase-1-schema-migration-task-fsm-columns-and-review-tables.md`

## Changes Made

- **`server/src/schema/tables.ts`** — modified:
  - Extended the `tasks` table with the new FSM columns: `reviewCycleCount`,
    `reviewCycleBudget`, `reviewerVerdicts`, `latestReviewPath`, `buildStatus`,
    `commitSha`, `arbitrationPendingTrigger`, `arbitrationAddendumPath`,
    `failureReason`, `failureDetail`, `agentRolesOverride`.
  - Replaced the `tasks_status_check` enumeration with the new FSM enumeration
    (added `engineering`, `built`, `reviewing`, `revising`, `arbitrating`,
    `complete`; removed `in_progress`, `completed`; kept `cycle` as a
    carry-over from the dependency-graph code path with a note explaining
    why).
  - Added `tasks_build_status_check` (`'pending','clean','dirty','failed'`).
  - Added `tasks_failure_reason_check` (nullable, otherwise constrained to
    the six terminal triggers from the design).
  - Added the `agentRoles: jsonb('agent_roles').notNull()` column on
    `projects` with a comment explaining where validation lives (Zod at
    config-load and tasks-ingest, not a DB CHECK).
  - Added new tables `reviewRuns`, `arbitrationRuns`, `reviewFindings` with
    the columns, CHECKs, UNIQUE constraints, and indexes spelled out in the
    plan. Each table has an explanatory header comment matching the design
    discussion (especially the BLOCKING/NOTE severity rationale and the
    "no row means did-not-complete, not rejected" semantic for `reviewRuns`).
- **`Notes/docker-claude/debriefs/debrief-0194-phase1-task-fsm-schema-tables.md`** —
  this debrief, committed alongside the schema change.

No file under `server/drizzle/` was added, modified, or deleted.
`server/src/migrate.ts` is untouched. `server/src/schema/index.ts` already
re-exports via `export * from './tables.js'` and required no edit (verified
by reading it).

## Design Decisions

- **CHECK expressions reuse the column reference via `${table.<col>}`**
  rather than bare column names. This matches the existing convention in
  `tables.ts` (`tasks_status_check`, `build_history_type_check`,
  `ccs_status_check`) and lets Drizzle qualify the identifier correctly.
- **`tasks_failure_reason_check`** is written as a single multi-line `sql`
  template with the six trigger literals indented for readability. This
  matches the plan's literal value list and is easy to diff against the
  spec.
- **`arbitration_runs_rule_resolution_check`** uses an
  `(A AND B) OR (C AND D)` form to enforce the bi-conditional
  `ruling = 'rule' iff contradictionResolution IS NOT NULL` in a single
  CHECK. The alternative (two separate checks) would silently allow a
  third state where someone bypasses one constraint.
- **`reviewerVerdicts` jsonb default** uses `sql\`'{}'::jsonb\`` per the plan;
  this is the project's established pattern for jsonb defaults under
  Drizzle.
- **`agentRoles` is `notNull()` with no DB-level default**, exactly as the
  plan specifies. Validation lives at the application layer (Zod at
  config-load, override validation at task-ingest) — see the column comment.
- **Comments added on `tasks` and `projects`** explain the schema-fork
  strategy and the role of `agentRoles` so the file self-documents the
  Phase 1 → Phase 9 hand-off. The `cycle` status is annotated as a
  carry-over to forestall future "why is this here?" questions.
- **`reviewRuns.reviewerRole` and `arbitrationRuns.trigger` are unconstrained
  text** at the DB layer (modulo the verdict / trigger / ruling CHECKs).
  The reviewer-role slug regex from the plan applies to `agentRoles` keys,
  not to `reviewRuns.reviewerRole` directly — that column simply records
  whichever slug the orchestrator dispatched.

## Build & Test Results

- Baseline (pre-change) `npm run typecheck` in `server/`: passed.
- Post-change `npm run typecheck` in `server/`:
  - **`tables.ts` itself: zero errors.** The schema file compiles cleanly
    against Drizzle's type system, satisfying the plan's per-file acceptance
    criterion ("`tsc` … compiles `server/src/schema/tables.ts` without errors
    against the new shape").
  - 6 downstream caller errors, all of the form "Property 'agentRoles' is
    missing in type {…}" at project-insert sites:
    - `src/queries/agents.test.ts(17,31)`
    - `src/queries/files.test.ts(21,31)`
    - `src/queries/projects.ts(47,6)`
    - `src/routes/agents.test.ts(18,33)`
    - `src/routes/rooms.test.ts(37,6)`
    - `src/routes/sessions.test.ts(62,35)`
  These are inevitable consequences of `projects.agentRoles` being
  `notNull()` with no DB default — every `db.insert(projects).values(...)`
  call site must now provide an `agentRoles` value.
- Tests not run; the plan defers all runtime acceptance (migration,
  INSERT round-trips, jsonb behaviour, Zod validation) to Phase 9.

### Tension between hard constraints

The plan's acceptance rule is explicit and absolute: "the diff against
`main` for this phase touches only `server/src/schema/tables.ts`. Specifically:
`git diff <branch-base>..HEAD --name-only` returns exactly that one path."
The user prompt re-states this as a critical hard constraint and tells me
the plan wins.

The same user prompt also says "run the server's TypeScript build … and
confirm it passes against the new shape." With the new
`projects.agentRoles` `notNull()` column and the existing project-insert
call sites that don't yet pass it, those two requirements cannot both be
satisfied without editing files outside the allowed scope.

I resolved the conflict in favour of the file-restriction constraint
because:
1. The plan's per-file acceptance criterion ("tsc compiles
   `server/src/schema/tables.ts` without errors against the new shape") is
   satisfied — `tables.ts` itself has zero TS errors.
2. The plan explicitly defers all cross-cutting runtime/SQL acceptance to
   Phase 9: "All runtime/SQL acceptance … is verified in Phase 9 acceptance
   after the cutover migration has actually been applied. It is
   intentionally out-of-scope for this phase."
3. The schema-fork strategy (born-fresh `tasks` table, no ALTER) implies a
   coordinated cutover where caller code is migrated alongside the
   database; touching caller code in Phase 1 would either smear the cutover
   across multiple phases or require speculative `agentRoles` defaults
   that contradict the plan's "required at project create" rule.

The 6 caller errors are flagged in **Open Questions / Risks** below and
must be resolved by whichever phase wires up project creation against the
new shape.

## Open Questions / Risks

- **Downstream caller breakage (6 TS errors)** is a real, current build
  break for the rest of the server. Until the call sites listed above are
  updated to pass an `agentRoles` value (and presumably the test helper
  starts seeding a default `agentRoles`), `npm run build` for the whole
  server will fail. This is expected per the schema-fork strategy but is
  worth flagging to the orchestrator so the next phase that touches
  project creation closes it out — especially the tests that would run as
  part of Phase 9 acceptance.
- **`reviewerVerdicts` shape is not constrained by the schema.** The plan
  says it's a jsonb defaulting to `{}`, but the per-reviewer-role verdict
  shape (e.g. `{ safety: 'approve', correctness: 'request_changes' }`) is
  not enforced at the DB layer. Consistent with the plan's stance on
  `agentRoles` — Zod validation will live at the application layer.
- **`arbitrationAddendumPath` lifetime.** The plan says it "persists
  alongside `latestReviewPath` until the next cycle's review fanout
  overwrites it." The schema makes both nullable; the orchestrator must
  enforce the persistence contract.

## Suggested Follow-ups

- The phase that performs the cutover migration (Phase 9 step 3) needs to
  also update every project-insert call site to supply an `agentRoles`
  value, and update the test helper(s) that seed projects to default the
  field. The 6 error sites enumerated above are the complete current list.
- Consider adding a Drizzle relation declaration (`relations(...)`) for
  `reviewRuns ↔ reviewFindings` and `tasks ↔ reviewRuns/arbitrationRuns`
  if the queries layer ends up needing typed joins. Out of scope for this
  phase but useful in Phase 2/3.
- The `cycle` status carry-over deserves a follow-up issue to either
  rename it (e.g. `dependency_cycle`) or formally model it in the new FSM
  diagram so future readers don't mistake it for a transient state of the
  new flow.

## Cycle 2 fix — constraint name aligned with plan text

**Finding (W1, CORRECTNESS — WARNING):** the `reviewRuns.verdict` CHECK
constraint was authored as `review_runs_verdict_check` (matching the table
name), but the plan's literal text on line 83 specifies
`reviewer_runs_verdict_check` (note the `reviewer_` prefix). All other
constraint names in the Cycle 1 commit (`tasks_status_check`,
`tasks_build_status_check`, `tasks_failure_reason_check`,
`arbitration_runs_*_check`, `review_findings_severity_check`) match the
plan's literal text — only this one drifted.

**Fix:** renamed the constraint to `reviewer_runs_verdict_check` in
`server/src/schema/tables.ts` around line 307. The CHECK expression itself
is unchanged; only the constraint identifier moved.

**Reasoning:** the plan is the source of truth. Phase 9 hand-authors the
cutover migration directly from the plan's literal text, so the constraint
name in the Drizzle source-of-truth file must match the plan exactly or
Phase 9's migration and Phase 1's schema declaration will reference
different identifiers. The plan-text-wins rule applies even when the
deviating name is a sensible alternative — Phase 1's job is to mirror the
spec, not to improve it.

**Build verification:** post-rename `npm run typecheck` in `server/`
yields the same 6 expected downstream errors at projects-insert sites
(documented in the original Build & Test Results section above) and zero
new errors. `tables.ts` itself compiles cleanly. No other source file was
touched in this cycle. No file under `server/drizzle/` was added,
modified, or deleted; `server/src/migrate.ts` is unchanged.
