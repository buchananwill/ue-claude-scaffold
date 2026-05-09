---

# Phase 9 — Hard cutover, legacy removal, and documentation

Part of [Plan: Durable Task FSM and Parallel Role Sessions](./_index.md). See the index for the shared goal and context — this phase body assumes them.

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
   - In `D:/Coding/resort_game/PistePerfect_5_7/CLAUDE.md`, replace the coordination-server section's "Task Creation — Plan-to-Queue Protocol" / "Coordination Server (port 9100)" content where it references the orchestrator, the legacy status values, and the existing message-board-based review trail. The replacement names: the new task statuses (`engineering`, `built`, `reviewing`, `revising`, `arbitrating`, `complete`); the new transition endpoints (`POST /tasks/:id/transition`, `POST /tasks/:id/reviews`, `POST /tasks/:id/arbitrations`, `GET /findings`, `GET /findings/note-patterns`, `GET /arbitrations`, `GET /failures/reasons`); the `.scratch/reviews/` and `.scratch/arbitrations/` workspace paths and their gitignore status; the per-task `agentRolesOverride` mechanism for one-off reviewer-set changes; the dashboard's new Findings, Arbitration, and Failure-reasons panels.
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

---

## Future work (not in scope)

These were named in the design conversation as desirable but explicitly deferred. They land as separate plans after this engine has stabilised.

- **Debrief migration to Supabase.** Retroactively parse the existing `Notes/docker-claude/debriefs/*.md` corpus into structured rows and remove from git history (or leave as fossil layer). Expected pattern mirrors `review_runs`/`review_findings` from Phase 1: a parent `debrief` row plus structured fields for task linkage, phase, cycle, decisions, follow-ups.
- **Debrief vector index.** Once debriefs are in Supabase, embed each debrief and run nearest-neighbour queries to surface "have we seen this failure mode before" during planning sessions. Exploratory; only worth pursuing once the FSM engine has produced enough new debriefs to make the corpus interesting.
