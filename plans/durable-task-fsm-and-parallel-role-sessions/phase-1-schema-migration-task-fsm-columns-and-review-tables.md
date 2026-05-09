---

# Phase 1 — Schema migration: task FSM columns and review tables

Part of [Plan: Durable Task FSM and Parallel Role Sessions](./_index.md). See the index for the shared goal and context — this phase body assumes them.

**Files:**
- `server/src/schema/tables.ts`
- `server/src/migrate.ts` (verify the migration runner picks up the new schema diff)
- `server/drizzle/<NNNN>_fsm_schema.sql` (Drizzle-generated migration; the actual cutover migration that forks the old `tasks` table is authored in Phase 9)

**Work:**
1. **Schema-fork strategy.** The new `tasks` table is born fresh, not ALTER-ed in place. `tables.ts` declares the final shape below; the cutover migration in Phase 9 step 3 archives the old `tasks` (and its dependents `task_files`, `task_dependencies`) by rename, then creates the new tables from scratch. No row migration — pre-cutover task rows live in `tasks_pre_fsm_archive` only and never transit the schema boundary. Phase 1's job is to author the new shape; Phase 9's job is to perform the rename-and-create cutover.

   On the new `tasks` table, define columns (existing carry-overs from the legacy table plus the new FSM columns):
   - `reviewCycleCount: integer('review_cycle_count').notNull().default(0)`
   - `reviewCycleBudget: integer('review_cycle_budget').notNull().default(5)`
   - `reviewerVerdicts: jsonb('reviewer_verdicts').notNull().default(sql`'{}'::jsonb`)`
   - `latestReviewPath: text('latest_review_path')`
   - `buildStatus: text('build_status').notNull().default('pending')`
   - `commitSha: text('commit_sha')`
   - `arbitrationPendingTrigger: text('arbitration_pending_trigger')` — set when transitioning into `arbitrating`; carries the trigger discriminator for the arbitrator dispatch script. Nullable; cleared on transition out of `arbitrating`.
   - `arbitrationAddendumPath: text('arbitration_addendum_path')` — set when an arbitrator rules `'rule'` on a contradiction; points the engineer's revising-cycle prompt at the ruling addendum file. Nullable; persists alongside `latestReviewPath` until the next cycle's review fanout overwrites it.
   - `failureReason: text('failure_reason')` — constrained enum (see CHECK below). Nullable; populated only on entry to `failed`.
   - `failureDetail: text('failure_detail')` — free-text per-instance specifics (which reviewer crashed, which findings contradicted, etc.). Nullable; populated alongside `failureReason`.
   - `agentRolesOverride: jsonb('agent_roles_override')` — per-task override of the project default agent-role wiring (see `projects.agentRoles` below). Nullable. Shape matches `projects.agentRoles`. Shallow per-top-level-key merge applied at task claim time: an override at `engineer` replaces only `engineer`; an override at `reviewers` replaces the whole reviewers map.
2. Update `tasks_status_check` to the new enumeration:
   ```
   CHECK (status IN (
     'pending','claimed','engineering','built','reviewing',
     'revising','arbitrating','complete','failed','integrated','cycle'
   ))
   ```
   The new table is born empty: no row remap is required because pre-cutover rows are archived under `tasks_pre_fsm_archive` (Phase 9 step 3) and never enter the new table. **Note on `'cycle'`:** this status comes from the existing branch-aware-task-lifecycle work and signals "circular dependency detected" — it is orthogonal to the new FSM and does not participate in any of the transitions added here. It persists in the enum because the dependency-graph code path needs it; new-FSM tasks never enter it.

2a. **`projects.agentRoles` jsonb (new column).** Add `agentRoles: jsonb('agent_roles').notNull()` on the `projects` table. Required at project create; no DB-level default (the value comes from `scaffold.config.json` at config-load — see Phase 9 documentation). Shape:
   ```json
   {
     "engineer": "<agent-file-name-without-md>",
     "arbitrator": "<agent-file-name-without-md>",
     "reviewers": {
       "<reviewer-role-slug>": "<agent-file-name-without-md>"
     }
   }
   ```
   - `engineer` and `arbitrator` are required string keys.
   - `reviewers` is a required object with at least one entry. Each key is a reviewer-role slug matching `^[a-z][a-z0-9_-]{0,31}$`. Each value is the bare agent-file basename (no `.md` extension) that must resolve to a compiled definition at `.compiled-agents/<name>.md` at task-dispatch time. Source definitions live under `dynamic-agents/<name>.md` (active, skills-composed; the launcher's preferred path) or `agents/<name>.md` (static fallback, no skills composition).
   - Unknown top-level keys are rejected at config-load.
   - PostgreSQL CHECK on jsonb shape is not enforced (CHECKs on nested jsonb structure are hostile to maintain). Validation lives at the application layer in `server/src/config-resolver.ts` (config-load) and the task-create path in `server/src/routes/tasks-ingest.ts` (override validation against the same Zod schema).
   - For piste-perfect, the value seeded at config-load resolves to:
     ```json
     {
       "engineer": "container-implementer-ue",
       "arbitrator": "container-arbitrator-ue",
       "reviewers": {
         "safety": "container-safety-reviewer-ue",
         "correctness": "container-reviewer-ue",
         "decomp": "container-decomposition-reviewer-ue"
       }
     }
     ```
3. Add `check('tasks_build_status_check', sql\`build_status IN ('pending','clean','dirty','failed')\`)`.
4. Add `check('tasks_failure_reason_check', sql\`failure_reason IS NULL OR failure_reason IN (
     'review_cycle_budget_exhausted',
     'reviewer_contradiction',
     'engineer_build_failure',
     'reviewer_infrastructure_failure',
     'role_session_no_op',
     'arbitrator_escalated'
   )\`)`. The first five values map to the five terminal triggers from the design discussion; `'arbitrator_escalated'` covers the cycle-exhausted-and-arbitrator-said-no path. `failureReason` is null when status is anything other than `failed`.
5. New table `reviewRuns` (per cycle, per reviewer):
   ```
   id: serial PK
   taskId: integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
   cycle: integer NOT NULL
   reviewerRole: text NOT NULL          -- e.g. 'safety', 'correctness', 'decomp'
   verdict: text NOT NULL               -- 'approve' | 'request_changes' | 'out_of_scope'
   rawMarkdown: text NOT NULL
   postedAt: timestamp NOT NULL DEFAULT now()
   UNIQUE (taskId, cycle, reviewerRole)
   ```
   Constraint: `reviewer_runs_verdict_check` on `verdict IN ('approve','request_changes','out_of_scope')`. Reviewer-session crashes are infrastructure events and are tracked via `claude_code_container_sessions.exitCode` (existing table) — they never produce a `reviewRuns` row at all. Absence of a row for a `(taskId, cycle, reviewerRole)` triple means "did not complete," not "rejected the code."
   Index: `idx_review_runs_task_cycle ON (taskId, cycle)`.
6. New table `arbitrationRuns` (per-task arbitrator ruling, at most one per trigger):
   ```
   id: serial PK
   taskId: integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
   trigger: text NOT NULL                    -- 'review_cycle_budget_exhausted' | 'reviewer_contradiction'
   ruling: text NOT NULL                     -- 'approve' | 'rule' | 'escalate'
   rulingMarkdown: text NOT NULL             -- the arbitrator's reasoning
   contradictionResolution: jsonb            -- nullable; only set when ruling='rule'
                                             --   { upheldFindingId: int, retiredFindingId: int, rationale: string }
   postedAt: timestamp NOT NULL DEFAULT now()
   UNIQUE (taskId, trigger)                  -- at most one arbitration per trigger per task
   ```
   Constraints: `arbitration_runs_trigger_check` on `trigger IN ('review_cycle_budget_exhausted','reviewer_contradiction')`; `arbitration_runs_ruling_check` on `ruling IN ('approve','rule','escalate')`; `arbitration_runs_rule_resolution_check` ensuring `contradictionResolution IS NOT NULL` when `ruling = 'rule'` and IS NULL otherwise. Index: `idx_arbitration_runs_task ON (taskId)`.

7. New table `reviewFindings` (per finding, child of run):
   ```
   id: serial PK
   runId: integer NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE
   severity: text NOT NULL              -- 'BLOCKING' | 'NOTE' (two-tier; see semantics below)
   ordinal: integer NOT NULL            -- 1, 2, 3... within run, preserves the reviewer's B1/N1 numbering
   filePath: text                       -- nullable; some findings are file-agnostic
   line: integer                        -- nullable
   title: text NOT NULL
   description: text NOT NULL
   evidence: text
   fix: text
   ```
   Constraint: `review_findings_severity_check` on `severity IN ('BLOCKING','NOTE')`. **Severity semantics:** `BLOCKING` means the engineer must address this finding before the cycle can transition to `complete`. `NOTE` is observability-only — the engineer never acts on a NOTE; it lands in the structured rows for the operator to aggregate across tasks (e.g. "I keep seeing NOTEs about lambda captures across the codebase — time to add a system-prompt rule"). The legacy `WARNING` tier is removed: under the previous orchestrator policy WARNINGs were always promoted to blocking anyway, so the gradation was theatre. Reviewers must commit: if it must be fixed this cycle, BLOCK; if it's a signal for later aggregation, NOTE; if it's neither, do not report it.
   Index: `idx_review_findings_run ON (runId)`, `idx_review_findings_task_severity ON (severity)` for cross-task queries.

   The schema barrel `server/src/schema/index.ts` is `export * from './tables.js'` already; new tables added to `tables.ts` are re-exported automatically. No manual edit needed there.

**Acceptance criteria:**
- `npm run --prefix server migrate` applies cleanly against a Supabase-equivalent local Postgres and against the live Supabase instance.
- `INSERT INTO tasks (project_id, title, status) VALUES ('piste-perfect','x','engineering')` succeeds.
- `INSERT INTO tasks (project_id, title, status) VALUES ('piste-perfect','x','garbage')` fails the CHECK.
- `INSERT INTO review_runs (task_id, cycle, reviewer_role, verdict, raw_markdown) VALUES (1, 1, 'safety', 'approve', '...')` succeeds.
- A second insert with the same `(task_id, cycle, reviewer_role)` fails the unique constraint.
- `INSERT INTO arbitration_runs (task_id, trigger, ruling, ruling_markdown) VALUES (1, 'review_cycle_budget_exhausted', 'approve', '...')` succeeds.
- A second insert with the same `(task_id, trigger)` fails the unique constraint.
- `INSERT INTO arbitration_runs ... ruling='rule'` without `contradictionResolution` fails the rule-resolution CHECK; with it, succeeds.
- `INSERT INTO projects (id, name, agent_roles) VALUES ('piste-perfect', 'Piste Perfect', '{"engineer":"container-implementer-ue","arbitrator":"container-arbitrator-ue","reviewers":{"safety":"container-safety-reviewer-ue","correctness":"container-reviewer-ue","decomp":"container-decomposition-reviewer-ue"}}')` succeeds.
- The application-layer Zod validator rejects an `agentRoles` jsonb missing `engineer`, missing `arbitrator`, missing `reviewers`, with an empty `reviewers`, with a reviewer-role slug containing uppercase, or with an unknown top-level key.
- After Phase 9's cutover migration runs, the new `tasks` table is empty; an INSERT with one of the new statuses (`'engineering'`, `'reviewing'`, etc.) succeeds; an INSERT carrying a legacy value (`'in_progress'`, `'completed'`) fails the new CHECK. Pre-cutover task rows survive untouched in `tasks_pre_fsm_archive`.
