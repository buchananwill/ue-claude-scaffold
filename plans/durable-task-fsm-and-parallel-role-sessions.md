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
- `database/supabase_v1.sql` (regenerate or add follow-up migration file per the project's Drizzle-on-Supabase convention)

**Work:**
1. On the existing `tasks` table, add columns:
   - `reviewCycleCount: integer('review_cycle_count').notNull().default(0)`
   - `reviewCycleBudget: integer('review_cycle_budget').notNull().default(5)`
   - `reviewerVerdicts: jsonb('reviewer_verdicts').notNull().default(sql`'{}'::jsonb`)`
   - `latestReviewPath: text('latest_review_path')`
   - `buildStatus: text('build_status').notNull().default('pending')`
   - `commitSha: text('commit_sha')`
   - `arbitrationPendingTrigger: text('arbitration_pending_trigger')` — set when transitioning into `arbitrating`; carries the trigger discriminator for the arbitrator dispatch script. Nullable; cleared on transition out of `arbitrating`.
   - `arbitrationsAddendumPath: text('arbitrations_addendum_path')` — set when an arbitrator rules `'rule'` on a contradiction; points the engineer's revising-cycle prompt at the ruling addendum file. Nullable; persists alongside `latestReviewPath` until the next cycle's review fanout overwrites it.
   - `failureReason: text('failure_reason')` — constrained enum (see CHECK below). Nullable; populated only on entry to `failed`.
   - `failureDetail: text('failure_detail')` — free-text per-instance specifics (which reviewer crashed, which findings contradicted, etc.). Nullable; populated alongside `failureReason`.
2. Update `tasks_status_check` to the new enumeration:
   ```
   CHECK (status IN (
     'pending','claimed','engineering','built','reviewing',
     'revising','arbitrating','complete','failed','integrated','cycle'
   ))
   ```
   Map of old → new for any existing rows: `'in_progress' → 'engineering'`, `'completed' → 'complete'`. `'pending' | 'claimed' | 'failed' | 'integrated' | 'cycle'` carry through unchanged.
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
8. Re-export all three new tables (`reviewRuns`, `reviewFindings`, `arbitrationRuns`) from `server/src/schema/index.ts`.

**Acceptance criteria:**
- `npm run --prefix server migrate` applies cleanly against a Supabase-equivalent local Postgres and against the live Supabase instance.
- `INSERT INTO tasks (project_id, title, status) VALUES ('piste-perfect','x','engineering')` succeeds.
- `INSERT INTO tasks (project_id, title, status) VALUES ('piste-perfect','x','garbage')` fails the CHECK.
- `INSERT INTO review_runs (task_id, cycle, reviewer_role, verdict, raw_markdown) VALUES (1, 1, 'safety', 'approve', '...')` succeeds.
- A second insert with the same `(task_id, cycle, reviewer_role)` fails the unique constraint.
- `INSERT INTO arbitration_runs (task_id, trigger, ruling, ruling_markdown) VALUES (1, 'review_cycle_budget_exhausted', 'approve', '...')` succeeds.
- A second insert with the same `(task_id, trigger)` fails the unique constraint.
- `INSERT INTO arbitration_runs ... ruling='rule'` without `contradictionResolution` fails the rule-resolution CHECK; with it, succeeds.
- All existing `tasks` rows survive the migration with their `status` values mapped per the table above.

<!-- PHASE-BOUNDARY -->

---

## Phase 2: Server FSM transition endpoint

**Files:**
- `server/src/routes/tasks-lifecycle.ts`
- `server/src/routes/tasks-lifecycle.test.ts`

**Work:**
1. Add `POST /tasks/:id/transition` accepting:
   ```
   {
     "to": "engineering" | "built" | "reviewing" | "revising" | "complete" | "failed",
     "payload": {
       "buildStatus"?: "clean" | "dirty" | "failed",
       "commitSha"?: string,
       "reviewerRole"?: string,                        // for reviewing→revising or reviewing→complete partials
       "verdict"?: "approve" | "request_changes" | "out_of_scope",
       "latestReviewPath"?: string,
       "failureReason"?: string                        // when to == "failed"
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
   - Per-payload field updates (`buildStatus`, `commitSha`, `latestReviewPath`).
   - Merge into `reviewerVerdicts` jsonb when the transition reports a per-reviewer verdict: `reviewerVerdicts[reviewerRole] = verdict`. The merge is the only update — never overwrite the whole object.
   - On entering `reviewing` from `built`, reset `reviewerVerdicts` to `{}`.
   - On entering `arbitrating`, set `arbitrationPendingTrigger` to the trigger discriminator.
   - On exiting `arbitrating` (to any of `complete`, `revising`, `failed`), clear `arbitrationPendingTrigger` to NULL.
   - On entering `failed`, set `failureReason` (constrained enum from Phase 1) and `failureDetail` (free text).
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
- From `arbitrating`, transitions to `complete`, `revising`, and `failed` are all valid (each gated on a corresponding arbitration POST landing first; see Phase 3).

<!-- PHASE-BOUNDARY -->

---

## Phase 3: Server review ingestion and consolidated-fetch endpoints

**Files:**
- `server/src/routes/reviews.ts` (new)
- `server/src/routes/reviews.test.ts` (new)
- `server/src/routes/index.ts` (register the new module)

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
3. `GET /tasks/:id/reviews/:cycle/consolidated` returns `text/markdown`:
   - Header line: `# Cycle <N> Review Consolidated — <task title>`.
   - For each run, in deterministic order (by `reviewerRole` ascending), a `## [<ROLE> REVIEW]` section followed verbatim by `rawMarkdown`.
   - 404 if no runs exist for the cycle.
4. `X-Project-Id` header required on all three endpoints.

**Acceptance criteria:**
- POST inserts the run plus N findings atomically; either both land or neither does.
- POST with `findings: []` is allowed (an `out_of_scope` or `approve` verdict has no findings) and returns `{ runId, findingIds: [] }`.
- Reposting the same `(taskId, cycle, reviewerRole)` returns 409.
- GET on a cycle with three runs returns three entries in the `runs` array.
- GET `.../consolidated` returns a single markdown document with three `## [<ROLE> REVIEW]` sections in alphabetical role order.
- A SQL query `SELECT severity, COUNT(*) FROM review_findings JOIN review_runs ON review_runs.id = review_findings.run_id WHERE review_runs.task_id IN (...) GROUP BY severity` runs and returns counts per severity — proves the structured findings are queryable for dashboard purposes.

<!-- PHASE-BOUNDARY -->

---

## Phase 4: Container daisy-chain entrypoint

**Files:**
- `container/lib/pump-loop.sh`
- `container/lib/run-claude.sh`
- `container/entrypoint.sh`
- `.gitignore` in target project repos (add `.scratch/reviews/`)

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
   - The session is responsible for posting its own transition. If the session exits cleanly but no transition was posted (we read `task.status` after and it's unchanged), post `failed` with reason `'role session returned without posting transition'`.
3. Crash recovery: when the container restarts (OAuth expiry, host reboot), the existing pump-loop already calls `claim-next`, but a task already mid-cycle won't be re-claimed by anyone else because its status is non-`pending`. Add a startup probe: on container start, query `GET /tasks?status=engineering,built,reviewing,revising,arbitrating&claimedByAgentId=<self>` and resume the daisy-chain on each.
4. Add `.gitignore` entries for `.scratch/reviews/` to both the scaffold repo and (via project bootstrap docs) every target project. The transient cycle artifacts must never be committed.
5. Container shutdown handler (`stop.sh` path): do **not** clear claimed tasks. The startup probe will resume them. The orchestrator is now stateless from the container's perspective.

**Acceptance criteria:**
- A claimed task with `status='engineering'` and a containerHost that matches the running container is picked up by the startup probe and resumed.
- The shell loop never reads `task.status='complete'` and re-launches a session for it.
- A session that exits without posting a transition causes the task to land in `failed` with the named reason.
- Killing the container mid-`reviewing` (after one of three reviewers has posted, two pending) and restarting causes the container to re-fan-out only the missing reviewers, not the one already posted.
- The `.scratch/reviews/` directory in any project worktree is never staged by `git status`.

<!-- PHASE-BOUNDARY -->

---

## Phase 5: Engineer top-level session dispatch

**Files:**
- `container/lib/run-claude.sh`
- `agents/container-implementer-ue.md` (prompt context updates only)
- `.compiled-agents/container-implementer-ue.md` (regenerated by agent compiler — mechanical)

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
   - **If `reviewCycleCount > 0`:** `task.latestReviewPath` (e.g. `.scratch/reviews/<task-id>/cycle-<N-1>/consolidated.md`). Instruction: *"Read the consolidated review at this path. Address every BLOCKING. NOTE entries are observability only — do not act on them. Re-build clean. Post `built` transition with the new commitSha."* No paraphrase of findings — engineer reads the raw consolidated file directly.
   - **If `reviewCycleCount == 0`:** Standard implement-from-plan instruction. Same shape as today.
3. The engineer session is responsible for posting its own transitions:
   - On clean build + commit + debrief: `POST /tasks/:id/transition {to: 'built', payload: {buildStatus: 'clean', commitSha}}`.
   - On unrecoverable build failure after retries: `POST /tasks/:id/transition {to: 'failed', payload: {failureReason}}`.
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
- `agents/container-safety-reviewer-ue.md`, `agents/container-reviewer-ue.md`, `agents/container-decomposition-reviewer-ue.md` (severity-tier collapse + structured-findings JSON output)
- `.compiled-agents/*.md` regenerated

**Work:**
1. After the `built → reviewing` transition, the daisy-chain calls `reviewer-fanout.sh <task-id> <cycle>`.
2. `reviewer-fanout.sh`:
   ```
   ROLES=(safety correctness decomp)        # decomp only on terminal cycle; safety+correctness every cycle
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
   Atomic rename guards against partial-write on crash mid-session.
3. Reviewer sessions are launched with **scoped permissions**, not `--dangerously-skip-permissions`:
   ```
   claude --allowed-tools "Read,Grep,Glob,Bash(git diff:*,git log:*,wc:*,ls:*)" \
          -p "$REVIEWER_PROMPT" \
          --append-system-prompt "$(cat .compiled-agents/container-<role>-reviewer-ue.md)" \
          --output-format json
   ```
   No `Edit`, no `Write`, no broad `Bash`. Reviewer cannot modify source code at all. Output goes to stdout, captured by the parent shell into the per-role file.
4. Each reviewer's prompt instructs: *"Your last action before exiting is to POST your verdict and findings to `${SERVER_URL}/tasks/<task-id>/reviews` with the structured payload below. Then exit."* The agent skill already produces a markdown report; amend the output schema to *also* emit a JSON block with structured `findings[]` matching the API shape from Phase 3. Reviewer parses its own markdown into the JSON before posting (yes, it's redundant; the markdown is the source of truth and the JSON is a structured shadow for Supabase queries).
5. **Severity-tier collapse in the reviewer skills.** Edit each of the three reviewer agent definitions to drop the WARNING tier:
   - Output template: remove the `## WARNING` section. Keep `## BLOCKING` and `## NOTE`. Renumber finding IDs as `B1, B2, ..., N1, N2, ...` (drop W-prefixed IDs).
   - Confidence threshold: replace the legacy three-tier scheme (`90-100 BLOCK / 75-89 WARN / 50-74 NOTE`) with a two-tier rule. Recommended language: *"BLOCK any finding you're at least 75% confident about and that requires action this cycle. NOTE any finding below 75% confidence OR any finding that does not require action but is worth aggregating across tasks. Do not report findings below 50% confidence."*
   - Remove the boilerplate line *"All WARNINGs are treated as blocking by the orchestrator. Only report issues you are confident about and can substantiate with specific code evidence."* — replace with *"NOTE entries are observability-only and never block a cycle. BLOCKING entries always block. Do not pad either tier with borderline calls; if you cannot substantiate the finding with specific code evidence, omit it."*
   - Update each skill's Output Schema section in `# Review Output Schema` accordingly. The verdict logic ("REQUEST CHANGES if any BLOCKING or WARNING exists") becomes "REQUEST CHANGES if any BLOCKING exists; APPROVE otherwise (NOTEs do not affect the verdict)."
6. **Reviewers are blind to each other.** No reviewer sees the cycle's consolidated file or another reviewer's per-role file. Each reviewer reads only the spec (plan path) and the changed source files. This preserves the parallel-and-blind property argued in the design conversation; sequential review with cross-reading was rejected for priming reasons.
7. After `wait` returns, the container's reviewer-fanout script:
   - Reads each `<role>.md` and constructs `consolidated.md` by literal concatenation with section headers (`## [<ROLE> REVIEW]`). No LLM in this step.
   - Writes `.scratch/reviews/<task-id>/cycle-<N>/consolidated.md`.
   - Examines the `verdict` from each reviewer (read from the JSON payload each reviewer wrote alongside its markdown). If all `approve` or `out_of_scope`: `POST /tasks/:id/transition {to: 'complete'}`. If any `request_changes`: `POST /tasks/:id/transition {to: 'revising', payload: {latestReviewPath: '.scratch/reviews/<task-id>/cycle-<N>/consolidated.md'}}`.
8. **Reviewer set is configurable per cycle.** Cycles 1..N-1 run safety + correctness. The terminal cycle (after `complete` would otherwise transition) additionally runs decomp. The current orchestrator's `Final Stage — Decomposition Review` becomes: when `complete` is about to be posted, instead transition to `reviewing` once more with only `decomp` declared, then `complete` only after decomp approves. This avoids a separate Final Stage codepath; it's the same FSM.

**Acceptance criteria:**
- Three reviewer subprocesses run concurrently (verifiable via `ps` or container logs showing overlapping start/end timestamps).
- Each reviewer's stdout lands in its own per-role file. No interleaving.
- A reviewer that crashes mid-session leaves a `.tmp` file and never POSTs to `/reviews`. The consolidation step detects the missing run for that `(taskId, cycle, reviewerRole)` triple and re-launches the single missing reviewer up to two times. If still missing after retries, the task transitions to `failed` with `failureReason: 'reviewer infrastructure failure: <role>'` — the *task* fails, not the reviewer's verdict (which was never rendered).
- `consolidated.md` is byte-identical to `cat safety.md correctness.md decomp.md` with section headers prepended.
- Three sequential `POST /tasks/:id/reviews` calls (one per reviewer) succeed and produce three rows in `review_runs` with shared `(taskId, cycle)`.
- A reviewer attempting `Write` or `Edit` on any source file fails with a tool-not-allowed error (proven by deliberately authoring a reviewer prompt that requests a file edit and observing the rejection).
- After all reviewers approve, status transitions to `complete` with a single follow-up reviewing cycle that runs decomp only; on decomp approve, `complete` lands.

<!-- PHASE-BOUNDARY -->

---

## Phase 7: Arbitrator agent and dispatch

**Files:**
- `agents/container-arbitrator-ue.md` (new agent definition)
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
     - `'rule'` → `arbitrating → revising`. Set `task.arbitrationsAddendumPath = '.scratch/arbitrations/<task-id>/contradiction-ruling.md'`. The engineer's next-cycle prompt (Phase 5 amendment in work-step 5 below) reads both `latestReviewPath` and `arbitrationsAddendumPath`.
     - `'escalate'` → `arbitrating → failed` with `failureReason: 'arbitrator_escalated'` and `failureDetail: <first 500 chars of rulingMarkdown>`
   - Return `{ runId, newStatus }`.
   - On unique constraint conflict (already-posted arbitration for `(taskId, trigger)`), return 409.
   - Validate: `contradictionResolution` MUST be present when `ruling = 'rule'`, MUST be absent otherwise. Validate: `trigger = 'reviewer_contradiction'` is the only trigger that accepts `ruling = 'rule'`; cycle-exhausted arbitrations may only `approve` or `escalate`.

2. **Container dispatch for `arbitrating` state.** When `role_for_status` returns `arbitrator`, the daisy-chain calls `arbitrator-dispatch.sh <task-id>`. This script:
   - Reads the task's pending arbitration trigger by querying `GET /tasks/:id` and reading `task.arbitrationPendingTrigger` (set by the Phase 2 transition endpoint when the task entered `arbitrating`).
   - Launches a single top-level `claude -p` session with the arbitrator prompt and scoped permissions (read-only; see step 3).
   - Captures stdout to `.scratch/arbitrations/<task-id>/<trigger>.md.tmp`, atomic-renames to `.md` on clean exit.
   - The arbitrator session is responsible for posting the `POST /tasks/:id/arbitrations` call itself; the dispatch script does not post on the agent's behalf.

3. **Arbitrator session permissions.** Same scoped-tools posture as reviewers — no Edit, no Write to source. Specifically:
   ```
   claude --allowed-tools "Read,Grep,Glob,Bash(git diff:*,git log:*,git show:*,wc:*,ls:*),WebFetch" \
          -p "$ARBITRATOR_PROMPT" \
          --append-system-prompt "$(cat .compiled-agents/container-arbitrator-ue.md)" \
          --output-format json \
          --model claude-opus-4-7
   ```
   The arbitrator runs Opus deliberately — this is the most consequential single judgment in the FSM and runs at most twice per task.

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
   The arbitrator does NOT edit `consolidated.md`. It writes the addendum and the engineer's prompt is updated (Phase 5 work-step 2 amendment) to: *"If `task.arbitrationsAddendumPath` is populated, read both `latestReviewPath` AND that addendum, treating the addendum as authoritative where it conflicts with the consolidated review."*

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
- `dashboard/src/api/types.ts` — extend the task type with the new fields (`reviewCycleCount`, `reviewCycleBudget`, `reviewerVerdicts`, `latestReviewPath`, `arbitrationPendingTrigger`, `arbitrationsAddendumPath`, `failureReason`, `failureDetail`); add `ReviewRun`, `ReviewFinding`, `ArbitrationRun` types
- `dashboard/src/router.tsx` — register the `/findings` route under `projectRoute`, with `validateSearch` for `severity`, `reviewer`, and `since` filters
- `dashboard/src/constants/task-statuses.ts` — add the new statuses (`engineering`, `built`, `reviewing`, `revising`, `arbitrating`, `complete`) so `VALID_TASK_STATUSES` accepts them in route search-params

**Work:**
1. Extend the task-detail view to show the FSM state explicitly: a status badge for current state, a cycle counter (`Cycle 2 / 5`), and a per-reviewer verdict strip (one chip per declared reviewer with state ∈ {pending, approve, request_changes, out_of_scope}). Read `reviewerVerdicts` jsonb directly.
2. Add a "Reviews" tab on the task detail. For each `(cycle, reviewerRole)` in `review_runs`:
   - Show the verdict and posted-at timestamp.
   - Render `rawMarkdown` (use the existing markdown renderer the dashboard already has for messages).
   - Below the markdown, show a structured table of findings (severity, file:line, title) sourced from `review_findings`. Click-through expands to description, evidence, fix.
3. Add a global "Findings" view at `/findings` listing the most recent BLOCKING findings across all tasks for the current project, with filters by reviewer role and date range. This is the queryable view that justifies the structured rows.
4. Add a "NOTE patterns" panel on the same view: aggregate NOTE-tier findings by `title` (exact-match, then loose-fuzzy if useful) over the last 30 days, sorted by occurrence count descending. NOTEs are observability-only by design — the operator scans this panel to spot recurring patterns that warrant escalating into a system-prompt rule, a skill amendment, or a new reviewer mandate. Top 20 entries with counts is enough; clicking an entry expands to the constituent findings.
5. **Arbitration rendering on the task-detail page.** When a task has rows in `arbitrationRuns`, render an "Arbitration" section per row showing: the trigger, the ruling, the ruling markdown (markdown-rendered), the timestamp, and (for `ruling='rule'`) the upheld vs. retired finding IDs with click-through to each finding's full content. A task at `arbitrating` state shows a pending placeholder until the arbitrator posts.
6. **Arbitration patterns panel.** On `/findings`, add a third panel alongside BLOCKING-recent and NOTE-patterns: an aggregated count of arbitrations grouped by `(trigger, ruling)` over the last 30 days. This is the operator's signal that one or both arbitrable failure modes are firing more than expected — a high `(review_cycle_budget_exhausted, escalate)` count means the cycle budget needs raising or reviewer prompts need tightening; a high `(reviewer_contradiction, *)` count means two reviewer mandates are systematically clashing.
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
- `agents/container-orchestrator-ue.md` — deleted
- `.compiled-agents/container-orchestrator-ue.md` — deleted (also clear from any compiled-agent index)
- `D:/Coding/resort_game/PistePerfect_5_7/CLAUDE.md` — coordination-server section rewritten to describe the new transition endpoints, the `.scratch/reviews/` workspace path, and the new task statuses
- `D:/Coding/ue-claude-scaffold/CLAUDE.md` — note the breaking change at the top with a one-line pointer to this plan and the schema migration file
- `D:/Coding/ue-claude-scaffold/README.md` — update any user-facing description of how task execution works
- `D:/Coding/ue-claude-scaffold/CHANGELOG.md` (create if absent) — record the breaking change with the date, the schema-migration filename, and the agents removed

**Work:**
1. **Stop the server and any running containers.** Operator action; no automation. `bash stop.sh` (or whatever the existing teardown is) brings everything to rest.
2. **Drain in-flight work on the operator's terms.** Before stopping, decide what to do with any tasks not in `complete` or `failed`:
   - Let them finish on the legacy orchestrator if convenient (operator-judgment call).
   - Or accept that they will be re-created post-migration and `POST /tasks/:id/reset` won't carry them through the new FSM cleanly — easier to delete and re-author.
   The plan does not prescribe a drain duration. There is no production SLA; the operator decides.
3. **Apply the schema migration.** With everything stopped, run the Drizzle migration generated in Phase 1 against the live Supabase project. The migration is idempotent and includes the status-value mapping for any `'in_progress'` and `'completed'` rows that survived the drain.
4. **Delete the legacy orchestrator artifacts.** Remove `agents/container-orchestrator-ue.md` and `.compiled-agents/container-orchestrator-ue.md`. Verify with `git grep container-orchestrator-ue`: zero matches in non-archived files. The `pump-loop.sh` already lives entirely in its new daisy-chain shape from Phase 4 — there is no legacy branch in it to remove, because Phase 4 was a replacement rather than an addition.
5. **Document the breaking change.**
   - In `D:/Coding/resort_game/PistePerfect_5_7/CLAUDE.md`, replace the coordination-server section's "Task Creation — Plan-to-Queue Protocol" / "Coordination Server (port 9100)" content where it references the orchestrator, the legacy status values, and the existing message-board-based review trail. The replacement names: the new task statuses (`engineering`, `built`, `reviewing`, `revising`, `arbitrating`, `complete`); the new transition endpoints (`POST /tasks/:id/transition`, `POST /tasks/:id/reviews`, `POST /tasks/:id/arbitrations`); the `.scratch/reviews/` and `.scratch/arbitrations/` workspace paths and their gitignore status; the dashboard's new Findings and Arbitration views.
   - In `D:/Coding/ue-claude-scaffold/CLAUDE.md`, add a top-of-file note: *"Task execution model changed [DATE]. The in-container orchestrator agent has been removed. Task lifecycle is a server-managed FSM dispatched by `pump-loop.sh`. See `plans/durable-task-fsm-and-parallel-role-sessions.md` and the schema migration `database/<migration-filename>.sql` for the canonical reference."*
   - In `CHANGELOG.md`, log the change with the date and the list of removed agent files.
6. **Spin everything back up and validate end-to-end.** Start server + one container. Author one trivial single-phase plan, batch one task, watch it traverse `pending → claimed → engineering → built → reviewing → complete → integrated` cleanly. Confirm the dashboard renders the FSM state, the per-reviewer chips, the consolidated review markdown, and (forced) the arbitrator view by intentionally driving a contradicting reviewer setup on a follow-up task.

**Acceptance criteria:**
- `git grep container-orchestrator-ue` in `D:/Coding/ue-claude-scaffold/` returns zero matches outside `plans/` and `notes/`.
- The Supabase migration is applied; `\d tasks` shows the new columns and the new status CHECK; `\d arbitration_runs`, `\d review_runs`, `\d review_findings` exist.
- A fresh end-to-end trivial task completes: `pending → ... → integrated` with `review_runs` populated for the cycle and the dashboard rendering each stage live.
- A deliberately-induced contradiction between two reviewers (e.g. one BLOCKING that demands extracting a helper, another BLOCKING that demands inlining the same logic) drives the FSM to `arbitrating`, the arbitrator session runs, posts a `'rule'` ruling, and the engineer's next cycle reads both `consolidated.md` and the addendum and finishes the task.
- `D:/Coding/resort_game/PistePerfect_5_7/CLAUDE.md` describes the new endpoints and statuses; a fresh interactive session reading it can author tasks for the new flow without referencing the removed orchestrator.

<!-- PHASE-BOUNDARY -->

---

## Future work (not in scope)

These were named in the design conversation as desirable but explicitly deferred. They land as separate plans after this engine has stabilised.

- **Debrief migration to Supabase.** Retroactively parse the existing `Notes/docker-claude/debriefs/*.md` corpus into structured rows and remove from git history (or leave as fossil layer). Expected pattern mirrors `review_runs`/`review_findings` from Phase 1: a parent `debrief` row plus structured fields for task linkage, phase, cycle, decisions, follow-ups.
- **Debrief vector index.** Once debriefs are in Supabase, embed each debrief and run nearest-neighbour queries to surface "have we seen this failure mode before" during planning sessions. Exploratory; only worth pursuing once the FSM engine has produced enough new debriefs to make the corpus interesting.
