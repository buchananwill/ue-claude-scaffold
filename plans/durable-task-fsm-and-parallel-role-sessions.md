# Plan: Durable Task FSM and Parallel Role Sessions

Lifts the in-container orchestrator's review-cycle state machine into Supabase, replaces the orchestrator agent with a deterministic shell daisy-chain, and runs each role (engineer, reviewers) as a top-level `claude -p` invocation rather than a sub-agent of an in-container orchestrator. Outcomes: every role gets full Agent tool depth (so engineers can dispatch Haiku helpers for cheap searches before duplicating shared code); review findings become structured queryable rows in Supabase rather than markdown blobs in git; container OAuth expiries and abnormal shutdowns no longer lose review cycle state because the FSM lives on the server.

The orchestrator agent (`.compiled-agents/container-orchestrator-ue.md`) is retired by this plan. Its quality protocol — build gate, parallel review fan-out, consolidation, 5-cycle budget, terminal style sweep — is preserved in full, but expressed as durable state transitions on the `tasks` table plus a thin shell loop, instead of an in-process Opus agent. The reviewer and engineer agent definitions themselves are unchanged in spirit; their invocation harness changes.

The debrief protocol is **not** touched in this plan. Migrating debriefs into Supabase and retiring `Notes/docker-claude/debriefs/` is deferred to a follow-up plan after this engine has run for a few weeks.

<!-- PHASE-BOUNDARY -->

---

## Phase 1: Schema migration — task FSM columns and review tables

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

<!-- PHASE-BOUNDARY -->

---

## Phase 2: Server FSM transition endpoint

**Files:**
- `server/src/routes/tasks-lifecycle.ts`
- `server/src/routes/tasks-lifecycle.test.ts`
- `server/src/queries/tasks-lifecycle.ts` (the queries module backing the lifecycle routes — its `complete()` and `fail()` query helpers are deleted alongside the route handlers)

**Work:**

0. **Legacy lifecycle endpoint disposition.** Delete `POST /tasks/:id/complete` and `POST /tasks/:id/fail` from `server/src/routes/tasks-lifecycle.ts` and the corresponding query helpers (`tasksLifecycleQ.complete`, `tasksLifecycleQ.fail`) from `server/src/queries/tasks-lifecycle.ts`. Both are superseded by `POST /tasks/:id/transition`. Their existing `claimed | in_progress` precondition would break the moment the new schema lands (`'in_progress'` no longer exists), and keeping them as parallel write paths to the same FSM rows would split the source of truth. Keep `POST /tasks/:id/reset` (operator-facing, recovers a `failed`/`cycle` task to `pending`) and `POST /tasks/:id/integrate` + `/integrate-batch` + `/integrate-all` (operator-facing, marks `complete` rows as `integrated`) — these are unchanged in semantics and continue to coexist with `/transition`.

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

<!-- PHASE-BOUNDARY -->

---

## Phase 3: Server review ingestion, per-task fetch, and cross-task aggregation endpoints

**Files:**
- `server/src/routes/reviews.ts` (new)
- `server/src/routes/reviews.test.ts` (new)
- `server/src/routes/findings.ts` (new) — cross-task BLOCKING-list and NOTE-pattern aggregation
- `server/src/routes/findings.test.ts` (new)
- `server/src/routes/index.ts` (register the two new modules)

**Work:**
1. `POST /tasks/:id/reviews` body:
   ```
   {
     "cycle": number,
     "reviewerRole": string,
     "verdict": "approve" | "request_changes" | "out_of_scope",
     "rawMarkdown": string,
     "findings": [
       {
         "severity": "BLOCKING" | "NOTE",
         "ordinal": number,
         "filePath"?: string,
         "line"?: number,
         "title": string,
         "description": string,
         "evidence"?: string,
         "fix"?: string
       }
     ]
   }
   ```
   In a single transaction:
   - Insert one row into `reviewRuns` with the supplied fields.
   - Insert N rows into `reviewFindings` referencing the new run.
   - Return `{ runId, findingIds: [...] }`.
   - On unique constraint conflict (already-posted run for `(taskId, cycle, reviewerRole)`), return 409 — the caller is duplicating; client must dedupe.
2. `GET /tasks/:id/reviews/:cycle` returns the per-run breakdown for that cycle:
   ```
   {
     "cycle": number,
     "runs": [
       { "reviewerRole", "verdict", "rawMarkdown", "findings": [...] }
     ]
   }
   ```
   Empty `runs` array if the cycle has no posted runs yet.
3. `GET /findings` — cross-task BLOCKING-recent list, project-scoped via `X-Project-Id`. Query params: `severity` (default `'BLOCKING'`, also accepts `'NOTE'`), `reviewer` (filter by reviewer-role slug, optional), `since` (ISO date, default now-30d), `limit` (default 50, max 200), `offset` (default 0). Returns:
   ```
   {
     "findings": [
       {
         "id": int, "taskId": int, "cycle": int, "reviewerRole": string,
         "severity": "BLOCKING" | "NOTE",
         "filePath": string|null, "line": int|null,
         "title": string, "postedAt": timestamp
       }
     ],
     "total": int
   }
   ```
   Joined query: `review_findings INNER JOIN review_runs ON review_runs.id = review_findings.run_id WHERE review_runs.task_id IN (project's tasks) AND severity = ? AND review_runs.posted_at >= ?`. Default sort by `postedAt DESC`.

4. `GET /findings/note-patterns` — aggregated NOTE-tier `title`-grouped counts, project-scoped. Query params: `since` (ISO date, default now-30d), `limit` (default 20, max 50). Returns:
   ```
   {
     "patterns": [
       { "title": string, "count": int, "exampleFindingIds": [int, int, int] }
     ]
   }
   ```
   Query: `SELECT title, COUNT(*) as count, ARRAY_AGG(id ORDER BY posted_at DESC LIMIT 3) as example_finding_ids FROM review_findings JOIN review_runs ON ... WHERE severity = 'NOTE' AND posted_at >= ? GROUP BY title ORDER BY count DESC LIMIT ?`. Project-scoping is applied by joining `tasks` and filtering on `tasks.project_id`.

5. `GET /arbitrations` — aggregated arbitration counts grouped by `(trigger, ruling)`, project-scoped. Query params: `since` (ISO date, default now-30d). Returns:
   ```
   {
     "patterns": [
       { "trigger": string, "ruling": string, "count": int, "exampleTaskIds": [int, int, int] }
     ]
   }
   ```
   Same shape as note-patterns but grouping on `(trigger, ruling)` and project-scoped via the `tasks` join.

6. `X-Project-Id` header required on all five endpoints. The cross-task endpoints (`/findings`, `/findings/note-patterns`, `/arbitrations`) scope all results to the requesting project — no cross-project leakage.

**Acceptance criteria:**
- `POST /tasks/:id/reviews` inserts the run plus N findings atomically; either both land or neither does.
- `POST /tasks/:id/reviews` with `findings: []` is allowed (an `approve` or `out_of_scope` verdict need not carry findings) and returns `{ runId, findingIds: [] }`. An `approve` verdict MAY also carry NOTE findings; the count is unconstrained.
- Reposting the same `(taskId, cycle, reviewerRole)` returns 409.
- `GET /tasks/:id/reviews/:cycle` on a cycle with three runs returns three entries in the `runs` array.
- `GET /findings?severity=BLOCKING&reviewer=safety&since=2026-04-01` returns matching rows project-scoped, sorted by `postedAt DESC`, paginated.
- `GET /findings/note-patterns` returns NOTE-tier titles grouped by exact-match count, top-N descending.
- `GET /arbitrations` returns arbitration counts grouped by `(trigger, ruling)` over the trailing 30 days.
- All cross-task endpoints reject requests missing `X-Project-Id` with 400.
- All cross-task endpoints scope to the requesting project — a finding from project A never appears in project B's results, even if `taskId` collides.

<!-- PHASE-BOUNDARY -->

---

## Phase 4: Container daisy-chain entrypoint

**Files:**
- `container/lib/pump-loop.sh`
- `container/lib/run-claude.sh`
- `container/entrypoint.sh`
- `server/src/routes/tasks.ts` (extend `GET /tasks` query parser to accept a `claimedByAgentId` UUID filter)
- `server/src/queries/tasks-core.ts` (extend the list query to apply the new filter)
- `.gitignore` in target project repos (add `.scratch/reviews/` and `.scratch/arbitrations/`)

**Work:**
1. Replace the per-task body of `pump-loop.sh` with a state-driven daisy-chain. After `POST /tasks/claim-next` returns a claimed task, enter a loop:
   ```
   while task.status not in (complete, failed, integrated):
     role = role_for_status(task)
     run_role_session "$role" "$task_id" "$cycle"
     task = GET /tasks/:id      # re-read to pick up any transition the session posted
   ```
   `role_for_status` mapping:
   - `claimed` or `revising` → `engineer`
   - `engineering` → `engineer` (resume; the session itself decides whether to continue or post `built`)
   - `built` → `reviewer-fanout` (Phase 6 expands this)
   - `reviewing` → `reviewer-fanout` for any reviewer not yet present in `reviewerVerdicts` (recovery from partial progress)
   - `arbitrating` → `arbitrator` (Phase 7 expands this)
   - `complete`, `failed`, `integrated` → exit task loop
2. `run_role_session` is a function that:
   - Creates `.scratch/reviews/<task-id>/cycle-<N>/` if it doesn't exist.
   - Calls `run-claude.sh <role> <task-id> <cycle>` and captures stdout/stderr to a per-role logfile under `.scratch/`.
   - The session is responsible for posting its own transition. If the session exits cleanly but no transition was posted (we read `task.status` after and it's unchanged), post `{to: 'failed', payload: {failureReason: 'role_session_no_op', failureDetail: 'role session for <role> returned without posting transition (cycle <N>)'}}`.

2a. **Effective agent-roles resolution.** At the start of each task loop iteration, the daisy-chain resolves the per-task agent-role wiring once and caches it for the loop's lifetime:
   ```
   project       = GET /projects/$PROJECT_ID
   task          = GET /tasks/:id
   roles         = shallow_merge(project.agentRoles, task.agentRolesOverride ?? {})
   ```
   `shallow_merge` replaces top-level keys (`engineer`, `arbitrator`, `reviewers`) wholesale. An override `{"reviewers": {"decomp": "custom-decomp-ue"}}` replaces the entire reviewers map, dropping safety and correctness — that is the documented contract; partial-reviewer overrides require restating the whole reviewers object. `run-claude.sh` reads from `roles` to choose the agent file and the permission posture for each invocation.
3. **Extend `GET /tasks` with a `claimedByAgentId` UUID filter.** The container's startup probe needs to recover only tasks claimed by *this* agent's UUID, not by name slot (agent UUIDs are identity; names are reusable UI labels). Add `claimedByAgentId` to the query parser in `server/src/routes/tasks.ts` and the conditions builder in `server/src/queries/tasks-core.ts`. Validate as a v4/v7 UUID; reject malformed input with 400. The filter applies a single `WHERE claimed_by_agent_id = ?` clause; no fan-out matching, no name-slot lookup.

4. **Startup probe.** On container start, query `GET /tasks?status=engineering,built,reviewing,revising,arbitrating&claimedByAgentId=<own-AGENT_ID>` and resume the daisy-chain on each returned row. A task already mid-cycle won't be re-claimed by anyone else because its status is non-`pending`; the probe is the only mechanism that picks it back up after an OAuth expiry or host reboot.

5. **Strip the auto-`/complete` and auto-`/fail` posts from `_run_claude`.** The current `container/lib/run-claude.sh` POSTs `/tasks/:id/complete` or `/tasks/:id/fail` based on Claude's exit code in its `if [ "$mode" = "task" ] && [ -n "${CURRENT_TASK_ID:-}" ]` block (lines ~291-308 of the file). Under the FSM, the role session itself posts the relevant `/transition` call; an additional auto-post from the wrapper would either double-write or clobber the FSM with a legacy `complete`/`fail` payload. Delete that block entirely. The wrapper continues to POST `/tasks/:id/release` on the abnormal-exit path (existing behavior, unchanged) — `release` is a different endpoint from `complete`/`fail` and remains valid for the "container died, hand the task back" recovery flow.

6. Add `.gitignore` entries for `.scratch/reviews/` and `.scratch/arbitrations/` to both the scaffold repo and (via project bootstrap docs) every target project. The transient cycle and arbitration artifacts must never be committed.

7. Container shutdown handler (`stop.sh` path): do **not** clear claimed tasks. The startup probe will resume them. The orchestrator is now stateless from the container's perspective.

8. **Preserve the existing pump-loop infrastructure.** The rewrite of `_pump_iteration` keeps the consecutive-non-complete circuit breaker (`_trip_noncomplete_circuit_breaker`), the abnormal-exit detection (`_detect_abnormal_exit` + `ABNORMAL_SHUTDOWN`), the agent-status pause/resume polling, the stop-signal sentinel (`/tmp/.stop_requested`), the agent-type-override fetch (`_ensure_agent_type`), and the per-task branch-reset between iterations. These are non-negotiable safety nets; the daisy-chain is layered *inside* this scaffolding, not in place of it.

**Acceptance criteria:**
- `GET /tasks?claimedByAgentId=<uuid>` returns only tasks claimed by that agent UUID; `GET /tasks?claimedByAgentId=not-a-uuid` returns 400.
- A task with `status='engineering'` and `claimed_by_agent_id` equal to the running container's `AGENT_ID` is picked up by the startup probe and resumed.
- The shell loop never reads `task.status='complete'` and re-launches a session for it.
- A clean engineer-session exit no longer triggers a `POST /tasks/:id/complete` from `run-claude.sh`. The only POSTs the wrapper makes against task-lifecycle endpoints after a clean exit are the role session's own `/transition` calls (or a `/release` on the abnormal-exit branch).
- A session that exits without posting a transition causes the task to land in `failed` with `failureReason='role_session_no_op'`.
- A task with `agentRolesOverride={"reviewers": {"decomp": "custom-decomp-ue"}}` runs only the decomp reviewer for that task (safety + correctness are dropped because the override replaces the whole reviewers map). The engineer and arbitrator come from the project default.
- Killing the container mid-`reviewing` (after one of three reviewers has posted, two pending) and restarting causes the container to re-fan-out only the missing reviewers, not the one already posted.
- The circuit-breaker, pause/resume polling, stop-signal handling, agent-type-override fetch, and per-task branch reset all continue to function under the new daisy-chain shape (no regression vs. legacy `_pump_iteration`).
- The `.scratch/reviews/` directory in any project worktree is never staged by `git status`.

<!-- PHASE-BOUNDARY -->

---

## Phase 5: Engineer top-level session dispatch

**Files:**
- `container/lib/run-claude.sh`
- `dynamic-agents/container-implementer-ue.md` (prompt context updates only — this is the active skills-composed source)
- `.compiled-agents/container-implementer-ue.md` (regenerated by agent compiler — mechanical, never hand-edited)

**Work:**
1. `run-claude.sh engineer <task-id> <cycle>` invokes:
   ```
   claude --dangerously-skip-permissions \
          -p "$ENGINEER_PROMPT" \
          --append-system-prompt "$(cat .compiled-agents/container-implementer-ue.md)" \
          --output-format json \
          > "$LOG_PATH"
   ```
   This is a top-level session. The implementer can spawn sub-agents (`ue-source-explorer`, `ue-code-reviewer` if it wants a self-review pass, Haiku grep helpers).
2. `$ENGINEER_PROMPT` is constructed from server state, not from an in-process orchestrator. Required pieces:
   - The plan path (e.g. `Notes/buildables/selection-context-plan.md`).
   - The exact phase identifier (read from `task.title` and `task.sourcePath`; the task title already encodes the phase per the case-sensitive paths + phase-prefix convention).
   - The current `reviewCycleCount`.
   - **If `reviewCycleCount == 0`:** Standard implement-from-plan instruction. Same shape as today.
   - **If `reviewCycleCount > 0` and `task.arbitrationAddendumPath IS NULL`:** include `task.latestReviewPath` (e.g. `.scratch/reviews/<task-id>/cycle-<N-1>/consolidated.md`). Instruction: *"Read the consolidated review at this path. Address every BLOCKING. NOTE entries are observability only — do not act on them. Re-build clean. Post `built` transition with the new commitSha."* No paraphrase of findings — engineer reads the raw consolidated file directly.
   - **If `reviewCycleCount > 0` and `task.arbitrationAddendumPath IS NOT NULL`:** include both `task.latestReviewPath` AND `task.arbitrationAddendumPath`. Instruction: *"Read the consolidated review at `latestReviewPath` AND the arbitrator addendum at `arbitrationAddendumPath`. The addendum is authoritative where it conflicts with the consolidated review — it names which BLOCKING finding was upheld and which was retired. Address only the upheld findings; ignore the retired one. NOTE entries are observability only. Re-build clean. Post `built` transition with the new commitSha."*
3. The engineer session is responsible for posting its own transitions:
   - On clean build + commit + debrief: `POST /tasks/:id/transition {to: 'built', payload: {buildStatus: 'clean', commitSha}}`.
   - On unrecoverable build failure after retries: `POST /tasks/:id/transition {to: 'failed', payload: {failureReason: 'engineer_build_failure', failureDetail: '<concise summary of the build error blocking progress>'}}`. The engineer prompt names the exact `failureReason` enum value so it never invents a free-text value that trips the CHECK.
4. **Engineer prompt discipline** (preserves the user's "engineers must not be primed with anti-patterns" property): the engineer system prompt is the *current* `container-implementer-ue` skill, plus a small amendment naming the new transition endpoints. Crucially, the engineer prompt must NOT inline the consolidated review markdown nor any anti-pattern language from reviewer skills. The engineer reads anti-pattern language only from the cycle's consolidated file, on demand, scoped to one read action and one fix pass.
5. **Contradiction escape hatch.** Append to the engineer's revision-cycle prompt: *"If two findings cannot both be satisfied (one says 'split this', another says 'lock this together'), do not pick one. Quote both findings verbatim and POST `/tasks/:id/transition {to: 'arbitrating', payload: {trigger: 'reviewer_contradiction', contradiction: {findingIds: [...], notes: '...'}}}`. An arbitrator session will rule between the findings or escalate to the operator."*

**Acceptance criteria:**
- A claimed task transitions through `claimed → engineering → built` in a single engineer session for a clean first pass.
- The engineer session, when invoked with `reviewCycleCount=2` and `latestReviewPath` populated, opens that file, applies fixes, and re-posts `built`.
- The engineer can spawn sub-agents during its session (verifiable from `claude_code_container_sessions.raw_output`'s tool-use entries showing Agent calls).
- Killing the engineer session mid-fix and restarting the container resumes the same task at `engineering` (status unchanged) and re-launches the engineer.
- A run with two genuinely contradictory findings transitions the task to `arbitrating` with `trigger='reviewer_contradiction'` rather than picking one or transitioning to `failed`.

<!-- PHASE-BOUNDARY -->

---

## Phase 6: Parallel reviewer dispatch and mechanical consolidation

**Files:**
- `container/lib/run-claude.sh`
- `container/lib/reviewer-fanout.sh` (new)
- `skills/review-output-schema/SKILL.md` (the canonical source of the BLOCKING/WARNING/NOTE template, the verdict logic, and the "All WARNINGs are treated as blocking" boilerplate; composed into every reviewer agent — editing here is what actually drops the WARNING tier)
- `dynamic-agents/container-safety-reviewer-ue.md`, `dynamic-agents/container-reviewer-ue.md`, `dynamic-agents/container-decomposition-reviewer-ue.md` (structured-findings JSON output instructions; any reviewer-specific text that referenced WARNINGs)
- `.compiled-agents/*.md` regenerated automatically

**Work:**
1. After the `built → reviewing` transition, the daisy-chain calls `reviewer-fanout.sh <task-id> <cycle>`.
2. `reviewer-fanout.sh`:
   ```
   # Reviewer set comes from the resolved per-task agent-roles (Phase 4 step 2a).
   # All declared reviewers run every cycle in parallel — no terminal-cycle special-casing.
   declared_roles=$(jq -r '.reviewers | keys[]' <<< "$EFFECTIVE_AGENT_ROLES")

   # Recovery: skip reviewers that already posted a row for this (task, cycle).
   already_posted=$(curl -s "${SERVER_URL}/tasks/${task_id}/reviews/${cycle}" \
                    | jq -r '.runs[].reviewerRole')
   ROLES=()
   for role in $declared_roles; do
     if ! grep -qx "$role" <<< "$already_posted"; then
       ROLES+=("$role")
     fi
   done

   for role in "${ROLES[@]}"; do
     run-claude.sh "reviewer-$role" "$task_id" "$cycle" \
       > ".scratch/reviews/$task_id/cycle-$cycle/$role.md.tmp" &
   done
   wait
   for role in "${ROLES[@]}"; do
     mv ".scratch/reviews/$task_id/cycle-$cycle/$role.md.tmp" \
        ".scratch/reviews/$task_id/cycle-$cycle/$role.md"
   done
   ```
   Atomic rename guards against partial-write on crash mid-session. The recovery skip means re-entering `reviewing` after a partial-progress crash only re-fans-out the missing reviewers — the already-posted ones are not re-run, preserving server-side row idempotence.

   **Decomp policy:** decomp runs every cycle alongside safety + correctness, in parallel. The legacy orchestrator's "Final Stage — Decomposition Review" optimization (run decomp only at plan end) is retired in this design. Per-cycle decomp catches DRY violations and trivial-repetition slop early, before they propagate across cycles. The token cost is accepted as the price of nipping decomposition rot in the bud.
3. Reviewer sessions are launched with **scoped permissions**, not `--dangerously-skip-permissions`:
   ```
   claude --allowed-tools "Read,Grep,Glob,Bash(git diff:*,git log:*,wc:*,ls:*)" \
          -p "$REVIEWER_PROMPT" \
          --append-system-prompt "$(cat .compiled-agents/container-<role>-reviewer-ue.md)" \
          --output-format json
   ```
   No `Edit`, no `Write`, no broad `Bash`. Reviewer cannot modify source code at all. Output goes to stdout, captured by the parent shell into the per-role file.
4. Each reviewer's prompt instructs: *"Your last action before exiting is to POST your verdict and findings to `${SERVER_URL}/tasks/<task-id>/reviews` with the structured payload below. Then exit."* The agent skill already produces a markdown report; amend the output schema to *also* emit a JSON block with structured `findings[]` matching the API shape from Phase 3. Reviewer parses its own markdown into the JSON before posting (yes, it's redundant; the markdown is the source of truth and the JSON is a structured shadow for Supabase queries).
5. **Severity-tier collapse in `skills/review-output-schema/SKILL.md`.** This skill is composed into every reviewer agent (front matter `skills:` list); the BLOCKING/WARNING/NOTE template, the confidence rubric, and the orchestrator-blocking sentence all live in this single file. Editing only the per-reviewer agent definitions would not take effect — the compiler would re-inject the WARNING tier from the skill at compile time. Apply the changes here:
   - **Template (currently lines ~12-38):** Remove the `## WARNING` section entirely. Keep `## BLOCKING` and add a `## NOTE` section (which the existing template only mentions parenthetically under "Rules"). Renumber finding IDs as `B1, B2, …, N1, N2, …` and drop the W-prefixed IDs.
   - **Confidence-threshold rule:** Replace the implicit three-tier scheme baked into the template confidence ranges (90-100 BLOCK / 75-89 WARN / 50-74 NOTE) with a two-tier rule. Suggested language: *"BLOCK any finding you're at least 75% confident about and that requires action this cycle. NOTE any finding below 75% confidence OR any finding that does not require action but is worth aggregating across tasks. Do not report findings below 50% confidence."*
   - **Orchestrator-blocking boilerplate (currently line 46):** Remove *"All WARNINGs are treated as blocking by the orchestrator. Only report issues you are confident about and can substantiate with specific code evidence. Do not pad with borderline nitpicks."* Replace with *"NOTE entries are observability-only and never block a cycle. BLOCKING entries always block. Do not pad either tier with borderline calls; if you cannot substantiate the finding with specific code evidence, omit it."*
   - **Verdict rule (currently line 44):** Change *"Verdict is REQUEST CHANGES if any BLOCKING or WARNING exists"* to *"Verdict is REQUEST CHANGES if any BLOCKING exists; APPROVE otherwise. NOTEs do not affect the verdict."*
   - **NOTE-tier line (currently line 45):** The current text reads *"Some domains add a NOTE tier (confidence 50-74, informational only). If present, NOTEs do not affect the verdict."* Replace with *"NOTE is a first-class tier alongside BLOCKING; every reviewer may emit NOTEs and they never affect the verdict."*
   - The Spec-Fidelity Finding Resolution section (currently lines 48-62) is unchanged.

   Per-reviewer agent definitions in `dynamic-agents/container-{safety,correctness,decomposition}-reviewer-ue.md` only need a sweep for any reviewer-specific text that mentions WARNINGs (e.g. category lists, examples). Most of the tier semantics flows from the skill above.
6. **Reviewers are blind to each other.** No reviewer sees the cycle's consolidated file or another reviewer's per-role file. Each reviewer reads only the spec (plan path) and the changed source files. This preserves the parallel-and-blind property argued in the design conversation; sequential review with cross-reading was rejected for priming reasons.
7. After `wait` returns, the container's reviewer-fanout script:
   - Reads each `<role>.md` and constructs `consolidated.md` by literal concatenation with section headers (`## [<ROLE> REVIEW]`). No LLM in this step.
   - Writes `.scratch/reviews/<task-id>/cycle-<N>/consolidated.md`.
   - Examines the `verdict` from each reviewer (read from the JSON payload each reviewer wrote alongside its markdown). If all `approve` or `out_of_scope`: `POST /tasks/:id/transition {to: 'complete'}`. If any `request_changes`: `POST /tasks/:id/transition {to: 'revising', payload: {latestReviewPath: '.scratch/reviews/<task-id>/cycle-<N>/consolidated.md'}}`.
8. **Reviewer set is project-default with per-task override.** The fanout iterates `effectiveAgentRoles.reviewers` (Phase 4 step 2a). For piste-perfect's default config, that's safety + correctness + decomp every cycle. A task with a custom `agentRolesOverride.reviewers` will run whatever set the override declares — useful for one-off tasks where, e.g., decomp is irrelevant (a docs-only phase). The fanout has no opinion about which reviewers should run; it dispatches whoever is declared.

**Acceptance criteria:**
- All declared reviewer subprocesses run concurrently (verifiable via `ps` or container logs showing overlapping start/end timestamps). For piste-perfect default config: three subprocesses (safety, correctness, decomp) every cycle.
- Each reviewer's stdout lands in its own per-role file. No interleaving.
- A reviewer that crashes mid-session leaves a `.tmp` file and never POSTs to `/reviews`. The fanout's recovery check detects the missing run for that `(taskId, cycle, reviewerRole)` triple and re-launches the single missing reviewer up to two times. If still missing after retries, the task transitions to `failed` with `failureReason: 'reviewer_infrastructure_failure'` and `failureDetail: '<role> reviewer did not produce a verdict after 2 retries (cycle <N>)'` — the *task* fails, not the reviewer's verdict (which was never rendered).
- **Recovery skip:** if `reviewer-fanout.sh` is invoked for a `(task, cycle)` where two of three reviewers have already posted runs, only the third reviewer is launched. Verifiable: kill the container after one reviewer has POSTed; restart; observe that the startup probe re-enters the `reviewing` state and the fanout dispatches only the two missing roles.
- `consolidated.md` is byte-identical to the alphabetically-ordered concatenation of the per-role files with `## [<ROLE> REVIEW]` section headers prepended.
- Three sequential `POST /tasks/:id/reviews` calls (one per reviewer) succeed and produce three rows in `review_runs` with shared `(taskId, cycle)`.
- A reviewer attempting `Write` or `Edit` on any source file fails with a tool-not-allowed error (proven by deliberately authoring a reviewer prompt that requests a file edit and observing the rejection).
- A task with `agentRolesOverride.reviewers = {"correctness": "container-reviewer-ue"}` runs only the correctness reviewer; safety and decomp are not dispatched.

<!-- PHASE-BOUNDARY -->

---

## Phase 7: Arbitrator agent and dispatch

**Files:**
- `dynamic-agents/container-arbitrator-ue.md` (new agent definition; lives in the active skills-composed tree alongside the other `*-ue.md` agents)
- `.compiled-agents/container-arbitrator-ue.md` (regenerated by agent compiler)
- `container/lib/run-claude.sh` (new dispatch path for `arbitrator` role)
- `container/lib/arbitrator-dispatch.sh` (new)
- `server/src/routes/arbitrations.ts` (new)
- `server/src/routes/arbitrations.test.ts` (new)
- `server/src/routes/index.ts` (register the new module)

**Work:**
1. **Server endpoint `POST /tasks/:id/arbitrations`.** Body:
   ```
   {
     "trigger": "review_cycle_budget_exhausted" | "reviewer_contradiction",
     "ruling": "approve" | "rule" | "escalate",
     "rulingMarkdown": string,
     "contradictionResolution"?: { upheldFindingId: int, retiredFindingId: int, rationale: string }
   }
   ```
   In a single transaction:
   - Insert one row into `arbitrationRuns` with the supplied fields.
   - Issue the corresponding task transition based on `ruling`:
     - `'approve'` → `arbitrating → complete`
     - `'rule'` → `arbitrating → revising`. Set `task.arbitrationAddendumPath = '.scratch/arbitrations/<task-id>/contradiction-ruling.md'`. The engineer's next-cycle prompt branch (Phase 5 work-step 2) reads both `latestReviewPath` and `arbitrationAddendumPath`.
     - `'escalate'` → `arbitrating → failed` with `failureReason: 'arbitrator_escalated'` and `failureDetail: <first 500 chars of rulingMarkdown>`
   - Return `{ runId, newStatus }`.
   - On unique constraint conflict (already-posted arbitration for `(taskId, trigger)`), return 409.
   - Validate: `contradictionResolution` MUST be present when `ruling = 'rule'`, MUST be absent otherwise. Validate: `trigger = 'reviewer_contradiction'` is the only trigger that accepts `ruling = 'rule'`; cycle-exhausted arbitrations may only `approve` or `escalate`.

2. **Container dispatch for `arbitrating` state.** When `role_for_status` returns `arbitrator`, the daisy-chain calls `arbitrator-dispatch.sh <task-id>`. This script:
   - Reads the task's pending arbitration trigger by querying `GET /tasks/:id` and reading `task.arbitrationPendingTrigger` (set by the Phase 2 transition endpoint when the task entered `arbitrating`).
   - Launches a single top-level `claude -p` session with the arbitrator prompt and scoped permissions (read-only; see step 3).
   - Captures stdout to `.scratch/arbitrations/<task-id>/<trigger>.md.tmp`, atomic-renames to `.md` on clean exit.
   - The arbitrator session is responsible for posting the `POST /tasks/:id/arbitrations` call itself; the dispatch script does not post on the agent's behalf.

3. **Arbitrator session permissions.** Same scoped-tools posture as reviewers — no Edit, no Write to source, no network. Specifically:
   ```
   claude --allowed-tools "Read,Grep,Glob,Bash(git diff:*,git log:*,git show:*,wc:*,ls:*)" \
          -p "$ARBITRATOR_PROMPT" \
          --append-system-prompt "$(cat .compiled-agents/container-arbitrator-ue.md)" \
          --output-format json \
          --model claude-opus-4-7
   ```
   The arbitrator runs Opus deliberately — this is the most consequential single judgment in the FSM and runs at most twice per task. WebFetch is intentionally excluded; the arbitrator works exclusively from local plan / commit / review-markdown files.

4. **Arbitrator prompt context.** The dispatch builds a prompt that names the trigger and points the arbitrator at:
   - The plan path (so the arbitrator knows what was being built).
   - For cycle-exhausted: every `consolidated.md` from cycles 1..N (`.scratch/reviews/<task-id>/cycle-{1..N}/consolidated.md`); the engineer's commit series for this task (`git log --oneline <branch-base>..HEAD -- <task files>`); and the diff between cycle N and cycle N-1 (the load-bearing signal — is the engineer regressing, churning, or converging on a hard call?).
   - For contradiction: the two contradicting finding IDs, the per-reviewer markdown for both reviewers (so the arbitrator sees full context, not just the engineer's restatement), and the changed source files.
   - The reviewer skill definitions in `.compiled-agents/container-{safety,correctness,decomp}-reviewer-ue.md` so the arbitrator understands each reviewer's mandate when adjudicating.
   - Explicit instruction: *"Your job is to identify whether convergence has effectively been achieved despite the trigger condition (cycle-exhausted: judge whether remaining BLOCKINGs are stylistic noise or substantive; contradiction: judge which finding's mandate takes precedence given the plan's intent). You may APPROVE / RULE / ESCALATE per the trigger. Be willing to ESCALATE — that is the correct call when the situation genuinely requires operator judgment, not a fallback to be avoided."*

5. **Contradiction-rule output convention.** When the arbitrator's ruling is `rule`, the arbitrator writes a separate addendum file at `.scratch/arbitrations/<task-id>/contradiction-ruling.md` containing:
   - The two findings quoted verbatim.
   - The arbitrator's choice and rationale.
   - An instruction the next engineer prompt will surface: *"Finding [B<X>] from [<role> reviewer] is upheld and must be addressed. Finding [B<Y>] from [<other role> reviewer] is retired by arbitrator ruling and must NOT be addressed in this cycle."*
   The arbitrator does NOT edit `consolidated.md`. The addendum is a separate file, and the engineer's prompt branch in Phase 5 work-step 2 already handles reading both files when `arbitrationAddendumPath` is populated.

6. **Arbitration uniqueness gates the second arbitrator dispatch.** If a task somehow re-enters a state that would dispatch the arbitrator a second time for the same trigger (e.g. operator manually resets without clearing the arbitration row), the server's 409 on the second `POST /arbitrations` causes the dispatch script to fail loudly; the daisy-chain treats it as `role_session_no_op` and the task lands in `failed`. This is the intended brake against arbitration loops.

**Acceptance criteria:**
- A task at cycle 5 receiving a `request_changes` verdict transitions to `arbitrating` (verified in Phase 2). The container's startup probe finds it. The arbitrator dispatch fires.
- The arbitrator session's outputs land in `.scratch/arbitrations/<task-id>/review_cycle_budget_exhausted.md`.
- A `POST /tasks/:id/arbitrations {ruling: 'approve', ...}` from the arbitrator transitions the task to `complete` and inserts the `arbitrationRuns` row atomically.
- A `POST /tasks/:id/arbitrations {ruling: 'rule', contradictionResolution: {...}}` for `trigger='reviewer_contradiction'` transitions to `revising` and the next engineer dispatch reads both the consolidated review and the addendum file.
- A `POST /tasks/:id/arbitrations {ruling: 'escalate', ...}` transitions to `failed` with `failureReason='arbitrator_escalated'` and `failureDetail` populated from the ruling.
- A second arbitration POST for the same `(taskId, trigger)` returns 409.
- A `POST /tasks/:id/arbitrations {trigger: 'review_cycle_budget_exhausted', ruling: 'rule'}` is rejected with 400 — `rule` is only valid for contradictions.
- The arbitrator attempting `Write` or `Edit` on any source file fails with a tool-not-allowed error (same proof as Phase 6 reviewer permission test).

<!-- PHASE-BOUNDARY -->

---

## Phase 8: Dashboard rendering of FSM and review tables

**Files:**
- `dashboard/src/pages/TaskDetailPage.tsx` — extend with FSM state, per-reviewer chips, Reviews tab, and Arbitration section
- `dashboard/src/pages/FindingsPage.tsx` (new) — global Findings, NOTE patterns, and arbitration patterns view
- `dashboard/src/api/client.ts` — add functions for the Phase 3 review endpoints and the Phase 7 arbitration endpoint
- `dashboard/src/api/types.ts` — extend the task type with the new fields (`reviewCycleCount`, `reviewCycleBudget`, `reviewerVerdicts`, `latestReviewPath`, `arbitrationPendingTrigger`, `arbitrationAddendumPath`, `failureReason`, `failureDetail`, `agentRolesOverride`); add `ReviewRun`, `ReviewFinding`, `ArbitrationRun`, `AgentRoles` types
- `dashboard/src/router.tsx` — register the `/findings` route under `projectRoute`, with `validateSearch` for `severity`, `reviewer`, and `since` filters
- `dashboard/src/constants/task-statuses.ts` — replace the legacy status set with the new one. The file exports `STATUS_LABELS` (the source of truth) and `TASK_STATUSES` (derived from `Object.keys(STATUS_LABELS)`). Drop the `'in_progress'` and `'completed'` keys from `STATUS_LABELS` (the new schema rejects those values). Keep `'pending'`, `'claimed'`, `'failed'`, `'integrated'`, `'cycle'` (unchanged carry-overs). Add `'engineering'`, `'built'`, `'reviewing'`, `'revising'`, `'arbitrating'`, `'complete'` with display labels and badge/color entries (suggested: engineering = amber, built = blue, reviewing = purple, revising = orange, arbitrating = magenta, complete = green). The local `VALID_TASK_STATUSES` Set inside `dashboard/src/router.tsx` is built from `TASK_STATUSES` and updates automatically; verify the router file's `validateSearch` callbacks compile against the new set.

**Work:**
1. Extend the task-detail view to show the FSM state explicitly: a status badge for current state, a cycle counter (`Cycle 2 / 5`), and a per-reviewer verdict strip (one chip per declared reviewer with state ∈ {pending, approve, request_changes, out_of_scope}). Read `reviewerVerdicts` jsonb directly.
2. Add a "Reviews" tab on the task detail. For each `(cycle, reviewerRole)` in `review_runs`:
   - Show the verdict and posted-at timestamp.
   - Render `rawMarkdown` (use the existing markdown renderer the dashboard already has for messages).
   - Below the markdown, show a structured table of findings (severity, file:line, title) sourced from `review_findings`. Click-through expands to description, evidence, fix.
3. Add a global "Findings" view at `/findings` listing the most recent BLOCKING findings across all tasks for the current project. Calls `GET /findings?severity=BLOCKING&reviewer=<role>&since=<date>&limit=50` (Phase 3). Filters bound to the URL search-params via `router.tsx`'s `validateSearch`. This is the queryable view that justifies the structured rows.
4. Add a "NOTE patterns" panel on the same view: calls `GET /findings/note-patterns?since=<date>&limit=20` (Phase 3). Aggregated NOTE-tier titles ranked by occurrence over the last 30 days. NOTEs are observability-only by design — the operator scans this panel to spot recurring patterns that warrant escalating into a system-prompt rule, a skill amendment, or a new reviewer mandate. Clicking an entry expands to the constituent findings (the endpoint returns up to 3 example finding IDs per pattern; click-through fetches full rows via `GET /tasks/:id/reviews/:cycle`).
5. **Arbitration rendering on the task-detail page.** When a task has rows in `arbitrationRuns`, render an "Arbitration" section per row showing: the trigger, the ruling, the ruling markdown (markdown-rendered), the timestamp, and (for `ruling='rule'`) the upheld vs. retired finding IDs with click-through to each finding's full content. A task at `arbitrating` state shows a pending placeholder until the arbitrator posts.
6. **Arbitration patterns panel.** On `/findings`, add a third panel alongside BLOCKING-recent and NOTE-patterns: calls `GET /arbitrations?since=<date>` (Phase 3). Aggregated counts grouped by `(trigger, ruling)` over the last 30 days. This is the operator's signal that one or both arbitrable failure modes are firing more than expected — a high `(review_cycle_budget_exhausted, escalate)` count means the cycle budget needs raising or reviewer prompts need tightening; a high `(reviewer_contradiction, *)` count means two reviewer mandates are systematically clashing.
7. The existing message-board view continues to read from `messages` unchanged. **Reviewer findings are no longer relayed through `messages`** in the new flow (Phase 6 has reviewers POST directly to `/reviews`); update the dashboard's task-detail page so it reads review state from `review_runs`, not from message-board scraping.

**Acceptance criteria:**
- The task-detail page on a `reviewing`-state task shows three reviewer chips, the current cycle, and the cycle budget.
- Clicking a reviewer chip with a `request_changes` verdict expands the rendered markdown and the structured findings table.
- The `/findings` view returns a paginated list of BLOCKING findings sorted by `posted_at` desc.
- A query like `findings?severity=BLOCKING&reviewer=safety&since=2026-04-01` returns only matching rows.
- The NOTE patterns panel renders the top 20 `title`-grouped NOTEs by occurrence count over the trailing 30 days; clicking a row expands to the constituent finding rows.
- A task with an `arbitrationRuns` row shows the "Arbitration" section with the rendered ruling markdown and (for contradictions) the upheld/retired finding callout.
- The arbitration patterns panel renders aggregated counts by `(trigger, ruling)` over the trailing 30 days.

<!-- PHASE-BOUNDARY -->

---

## Phase 9: Hard cutover, legacy removal, and documentation

The coordination server is on-demand, not a hot service with external dependents. The cutover is therefore a clean break, not a runtime dual-mode rollout. The tasks under this phase document the breaking change, drain in-flight work on the operator's terms, apply the migration, and remove the now-orphaned orchestrator artifacts.

**Files:**
- `dynamic-agents/container-orchestrator-ue.md` — deleted (the active orchestrator source; deleting it causes the next compile to drop `.compiled-agents/container-orchestrator-ue.md` automatically)
- `.compiled-agents/container-orchestrator-ue.md` — deleted directly as well so the cutover removes the stale compiled artifact in the same commit (the next compile would drop it anyway, but explicit deletion keeps the cutover atomic)
- `server/drizzle/<NNNN>_fork_tasks_for_fsm.sql` — the cutover migration that performs the schema fork (rename old, create new, rebind dependents). Hand-authored or post-edited from a Drizzle-generated stub; see step 3 below
- `scaffold.config.json` — add `agentRoles` per-project field (see Phase 1 schema). Document in this file's existing schema note.
- `scaffold.config.example.json` — add the `agentRoles` example block for piste-perfect.
- `D:/Coding/resort_game/PistePerfect_5_7/CLAUDE.md` — coordination-server section rewritten to describe the new transition endpoints, the `.scratch/reviews/` and `.scratch/arbitrations/` workspace paths, and the new task statuses
- `D:/Coding/ue-claude-scaffold/CLAUDE.md` — note the breaking change at the top with a one-line pointer to this plan and the schema migration file
- `D:/Coding/ue-claude-scaffold/README.md` — update any user-facing description of how task execution works
- `D:/Coding/ue-claude-scaffold/CHANGELOG.md` (create if absent) — record the breaking change with the date, the schema-migration filename, and the agents removed

**Work:**
1. **Decide the disposition of in-flight work first.** Query `SELECT id, title, status FROM tasks WHERE status NOT IN ('completed','failed','integrated','pending')` against the live Supabase. (Note the legacy status values — pre-cutover, `'completed'` and `'in_progress'` are still in effect.) For each row, choose one of two paths:
   - **Drain on the legacy engine** — keep the legacy orchestrator running until that task lands in `'completed'` or `'failed'`. Then proceed to step 2. Drained rows still end up archived under `tasks_pre_fsm_archive` (because the fork is unconditional), but they at least represent finished work rather than mid-cycle stranded state.
   - **Accept archival** — do nothing now. The task will land untouched in `tasks_pre_fsm_archive` after step 3 with whatever status it currently holds. The operator re-authors it as a fresh task in the new schema if and when the work still matters.
   The plan does not prescribe which choice for which task. There is no production SLA; operator decides per task. Either way, no row crosses the schema boundary — the fork's purpose is exactly that firebreak.
2. **Once disposition is settled, stop the server and any running containers.** `bash stop.sh` (or whatever the existing teardown command is) brings everything to rest. No new tasks can claim while the migration runs.
3. **Apply the cutover migration.** A single Drizzle migration (`server/drizzle/<NNNN>_fork_tasks_for_fsm.sql`) performs the fork in one transaction. The required SQL operations, in order:
   1. `ALTER TABLE tasks RENAME TO tasks_pre_fsm_archive;`
   2. `ALTER TABLE task_files RENAME TO task_files_pre_fsm_archive;`
   3. `ALTER TABLE task_dependencies RENAME TO task_dependencies_pre_fsm_archive;`
   4. `ALTER TABLE claude_code_container_sessions DROP CONSTRAINT claude_code_container_sessions_task_id_fkey;` — convert `task_id` to a soft reference. The `ON DELETE SET NULL` semantics already labelled it best-effort; this drop just removes the database-level enforcement. Historical session rows continue to reference archived task IDs; new session rows reference new task IDs. SQL joins from sessions to either table work; no data loss.
   5. `CREATE TABLE tasks (...)` per the Phase 1 schema (full new shape with FSM columns, new CHECK, fresh `serial` sequence). `CREATE TABLE task_files (...)` and `CREATE TABLE task_dependencies (...)` with FKs into the new `tasks(id)`.
   6. `CREATE TABLE review_runs (...)`, `CREATE TABLE review_findings (...)`, `CREATE TABLE arbitration_runs (...)` per Phase 1 — these have no v1 counterparts to archive.
   7. `ALTER TABLE projects ADD COLUMN agent_roles jsonb NOT NULL DEFAULT '{}'::jsonb;` — see step 4 for seeding actual role wiring.

   `drizzle-kit` may not produce the rename + recreate sequence automatically (it tends to emit `DROP TABLE` / `CREATE TABLE` for shape diffs of this size). Generate the stub, then post-edit the SQL to use `RENAME TO …_pre_fsm_archive` instead of `DROP TABLE` for the four affected tables. Verify the migration runs cleanly against a PGlite snapshot of the live Supabase schema before applying to production.

4. **Seed `projects.agentRoles`.** Run `UPDATE projects SET agent_roles = '{...}'::jsonb WHERE id = 'piste-perfect'` populating the canonical config from `scaffold.config.json`. Repeat for any other registered project. Without this, task dispatch fails with "agent file not found" because no role wiring exists. The Phase 1 schema declares `agentRoles NOT NULL`; the migration's `DEFAULT '{}'::jsonb` from step 3 satisfies the NOT NULL constraint at table-create but produces an empty role map that the application Zod validator will reject — this seed must run before the server is restarted in step 7.

5. **Delete the legacy orchestrator artifacts.** Remove `dynamic-agents/container-orchestrator-ue.md` and `.compiled-agents/container-orchestrator-ue.md`. Verify with `git grep container-orchestrator-ue`: zero matches outside `plans/` and `notes/`. The `pump-loop.sh` already lives entirely in its new daisy-chain shape from Phase 4 — there is no legacy branch in it to remove.
6. **Document the breaking change.**
   - In `D:/Coding/resort_game/PistePerfect_5_7/CLAUDE.md`, replace the coordination-server section's "Task Creation — Plan-to-Queue Protocol" / "Coordination Server (port 9100)" content where it references the orchestrator, the legacy status values, and the existing message-board-based review trail. The replacement names: the new task statuses (`engineering`, `built`, `reviewing`, `revising`, `arbitrating`, `complete`); the new transition endpoints (`POST /tasks/:id/transition`, `POST /tasks/:id/reviews`, `POST /tasks/:id/arbitrations`, `GET /findings`, `GET /findings/note-patterns`, `GET /arbitrations`); the `.scratch/reviews/` and `.scratch/arbitrations/` workspace paths and their gitignore status; the per-task `agentRolesOverride` mechanism for one-off reviewer-set changes; the dashboard's new Findings and Arbitration views.
   - In `D:/Coding/ue-claude-scaffold/CLAUDE.md`, add a top-of-file note: *"Task execution model changed [DATE]. The in-container orchestrator agent has been removed. Task lifecycle is a server-managed FSM dispatched by `pump-loop.sh`. Per-project agent-role wiring lives in `scaffold.config.json` under the `agentRoles` field. See `plans/durable-task-fsm-and-parallel-role-sessions.md` and the schema migration file under `server/drizzle/` for the canonical reference."*
   - In `CHANGELOG.md`, log the change with the date, the list of removed agent files, and the schema migration filename.
7. **Spin everything back up and validate end-to-end.** Start server + one container. Author one trivial single-phase plan, batch one task, watch it traverse `pending → claimed → engineering → built → reviewing → complete` cleanly. (`complete → integrated` is the existing manual flow and is out of scope for this validation.) Confirm the dashboard renders the FSM state, the per-reviewer chips, and the consolidated review markdown. Then run a deliberate-contradiction follow-up task to exercise the arbitrator path end-to-end.

**Acceptance criteria:**
- `git grep container-orchestrator-ue` in `D:/Coding/ue-claude-scaffold/` returns zero matches outside `plans/` and `notes/`.
- The cutover migration is applied; `\d tasks` shows the new columns and the new status CHECK; `\d arbitration_runs`, `\d review_runs`, `\d review_findings` exist; `SELECT agent_roles FROM projects WHERE id = 'piste-perfect'` returns the seeded jsonb.
- `\d tasks_pre_fsm_archive`, `\d task_files_pre_fsm_archive`, `\d task_dependencies_pre_fsm_archive` all exist with their pre-cutover shape and rows preserved. `SELECT COUNT(*) FROM tasks_pre_fsm_archive` returns the pre-cutover row count from step 1's pre-flight query.
- `\d claude_code_container_sessions` shows `task_id` as a soft column (no `_fkey` constraint listed). Historical session rows still hold their pre-cutover `task_id` integers; new session rows hold IDs from the new `tasks` table; SQL joins to either table work.
- A fresh end-to-end trivial task completes through `pending → claimed → engineering → built → reviewing → complete` with `review_runs` populated for the cycle and the dashboard rendering each stage live. (Manual `complete → integrated` is verified separately and is unchanged from the legacy flow.)
- A deliberately-induced contradiction between two reviewers (e.g. one BLOCKING that demands extracting a helper, another BLOCKING that demands inlining the same logic) drives the FSM to `arbitrating`, the arbitrator session runs, posts a `'rule'` ruling, and the engineer's next cycle reads both `consolidated.md` and the addendum and finishes the task.
- `D:/Coding/resort_game/PistePerfect_5_7/CLAUDE.md` describes the new endpoints and statuses; a fresh interactive session reading it can author tasks for the new flow without referencing the removed orchestrator.

<!-- PHASE-BOUNDARY -->

---

## Future work (not in scope)

These were named in the design conversation as desirable but explicitly deferred. They land as separate plans after this engine has stabilised.

- **Debrief migration to Supabase.** Retroactively parse the existing `Notes/docker-claude/debriefs/*.md` corpus into structured rows and remove from git history (or leave as fossil layer). Expected pattern mirrors `review_runs`/`review_findings` from Phase 1: a parent `debrief` row plus structured fields for task linkage, phase, cycle, decisions, follow-ups.
- **Debrief vector index.** Once debriefs are in Supabase, embed each debrief and run nearest-neighbour queries to surface "have we seen this failure mode before" during planning sessions. Exploratory; only worth pursuing once the FSM engine has produced enough new debriefs to make the corpus interesting.
