# Schema hardening V2.5 — surrogate agent PKs, full FKs, soft-delete

## Context

The multi-tenancy migration gave every data table a `project_id text` column but never upgraded the schema to treat `(project_id, name)` as load-bearing. `agents.name` is a global primary key (`server/src/schema/tables.ts:19`), every cross-table reference to an agent is a plain text column without a constraint, and every `project_id` column lacks an FK to `projects`. The result was observed on 2026-04-08: `agent-1` in project A shut down during an idle pump timeout, its `_shutdown` called `DELETE /agents/agent-1` with no project scope, and the unconditional `tasksLifecycleQ.releaseByAgent('agent-1')` released an active task belonging to `agent-1` in project B.

This plan folds together three overdue repairs into one migration:

1. Surrogate UUID v7 primary key on `agents`, with `unique(project_id, name)`. Every cross-table reference to an agent becomes a single-column FK on the UUID.
2. Agent rows are never hard-deleted in normal operation. A new `status = 'deleted'` soft-delete state replaces row removal. Real purges become a rare vacuum-class operation, out of scope here. This eliminates audit trail corruption risk and removes any need for "name-at-time-of-write" denormalization on historical tables.
3. Full foreign key adoption across all 9 data tables — both `project_id` FKs to `projects` (absorbing `plans/project-id-foreign-keys.md` into this effort) and agent FKs throughout. `ON DELETE RESTRICT` is the default; the database itself enforces the integrity the application layer was supposed to but didn't.

All work lands on a single branch in a single container run. Merge once; revert whole if needed. No compatibility shims, no phased rollout, no backwards compatibility for old text references.

## Design decisions (locked — do not re-evaluate mid-execution)

**Surrogate PK type:** `text` column named `id` on `agents`, holding a UUID v7 string generated in JS via the `uuid` npm package (v11+). Rationale: PGlite's native `uuid` type and extension support are unreliable; `text` with a JS-generated value is portable, comparable, and works identically in tests. UUID v7 is time-ordered so B-tree index locality stays healthy.

**Soft-delete:** add the value `'deleted'` to the set of valid `agents.status` values. `status` remains `text` (no enum). The documented valid values become: `idle | working | done | error | paused | stopping | deleted`. `DELETE /agents/:name` flips `status` to `deleted` and releases transient claims (files, tasks, ubt locks) but leaves the row in place. The row's FK references from `messages`, `build_history`, etc. remain intact.

**Unique constraint on `(project_id, name)`:** enforced even for soft-deleted rows. A new container registering `agent-1` in a project where an older `agent-1` is in `status = 'deleted'` must either reject or deliberately reactivate the existing row. The register path will reactivate — flipping status back to `idle`, rotating `session_token`, and updating `container_host` — rather than inserting a new row. This prevents audit trail spoofing: the historical agent-1 is the same row, tracked continuously across its lifetime, never two distinct UUIDs.

**FK semantics:** `ON DELETE RESTRICT` for every FK added in this pass. `ON DELETE CASCADE` is reserved for the future vacuum tooling and is not used here. The only exception is `task_files` / `task_dependencies` within-table references, which were never broken and retain their existing `ON DELETE CASCADE` if any (verify during step 4).

**Name-at-time-of-write columns:** not added. Soft-delete obviates the need.

**`room_members.member` polymorphism:** resolved by adding a nullable `agent_id text` FK column while keeping the existing `member` text column for display and operator identification. The FK is enforced only when `agent_id IS NOT NULL`. The operator row continues to use `agent_id = NULL, member = 'user'`. Uniqueness is enforced by two partial unique indexes: one on `(room_id, agent_id) WHERE agent_id IS NOT NULL`, one on `(room_id) WHERE agent_id IS NULL` (one operator per room).

**`agent_type` column on `agents`:** out of scope for this plan. Listed as a follow-up in the acceptance section. Adding it later is a simple column addition and does not require another schema rewrite.

**Historical data:** the local PGlite database can be wiped during the migration if backfill becomes awkward. Agent rows are session-scoped and are recreated by live containers on next register. Tasks, messages, and build history are operator-visible but not irreplaceable. Wiping is preferable to shipping ambiguous backfill logic.

## Execution order

1. `cd server && npm install uuid@^11` to add the UUID v7 generator. Confirm `@types/uuid` is bundled or install separately if not.

2. Audit current usage of each cross-table reference. Run a grep for each of: `tasks.claimedBy`, `files.claimant`, `builds.agent` (in `buildHistory`), `ubtLock.holder`, `ubtQueue.agent`, `messages.agent`, `roomMembers.member`, `teamMembers.agentName`. For each, catalogue (a) the column's current name in `tables.ts`, (b) every query file that reads or writes it, and (c) every test file that exercises it. The result is a work list consumed by steps 9–15. Write the audit results as scratch text into `plans/schema-hardening-v25-audit.md` and commit it alongside the plan. Delete the audit file before the final merge.

3. Edit `server/src/schema/tables.ts`, working top-to-bottom. For the `agents` table:
   - Add `id: text('id').primaryKey()` as the first field.
   - Remove `.primaryKey()` from the existing `name: text('name')` declaration.
   - Leave `project_id text notNull` as is for now (the `.references(...)` call comes in step 4).
   - Add a table-level `unique('agents_project_name_unique').on(table.projectId, table.name)` using the `(table) => [...]` callback form.
   - Add the `deleted` status to any inline comment enumerating valid statuses.
   - Ensure `sessionToken` still has `.unique()` (it should — do not remove).

4. Still in `tables.ts`, add `.references(() => projects.id)` on `project_id` in all 9 data tables (agents, ubtLock, ubtQueue, buildHistory, messages, tasks, files, rooms, teams). Drop the `.default('default')` on each — the default-`default` behavior was a prototype holdover, and the FK makes an implicit default unsafe. Tests that relied on the default must pass an explicit `projectId`.

5. Still in `tables.ts`, replace every text column that references an agent by name with a UUID FK to `agents.id`. Specifically:
   - `tasks.claimedBy` (`text`, nullable) → rename to `claimedByAgentId text REFERENCES agents(id) ON DELETE RESTRICT`, nullable.
   - `files.claimant` (`text`, nullable) → rename to `claimantAgentId text REFERENCES agents(id) ON DELETE RESTRICT`, nullable.
   - `buildHistory.agent` (`text`, not nullable) → rename to `agentId text REFERENCES agents(id) ON DELETE RESTRICT`, not nullable.
   - `ubtLock.holder` (`text`, nullable — it is released) → rename to `holderAgentId text REFERENCES agents(id) ON DELETE RESTRICT`, nullable.
   - `ubtQueue.agent` (`text`, not nullable) → rename to `agentId text REFERENCES agents(id) ON DELETE RESTRICT`, not nullable.
   - `messages.agent` (if it exists as an agent ref — check its actual semantics; it may be a free-form label) → if referential, rename to `agentId text REFERENCES agents(id) ON DELETE RESTRICT`. If it is a display label (e.g. "user", "system"), leave it as text and add a new nullable `agentId` FK column alongside it.
   - `teamMembers.agentName` → rename to `agentId text REFERENCES agents(id) ON DELETE RESTRICT`, and update the composite PK on `(team_id, agent_name)` to `(team_id, agent_id)`.

6. Still in `tables.ts`, resolve the `room_members.member` polymorphism:
   - Keep the existing `member text notNull` column as a display name / operator discriminator.
   - Add `agentId text REFERENCES agents(id) ON DELETE RESTRICT`, nullable.
   - Remove the existing composite PK on `(room_id, member)`.
   - Add a surrogate `id text primaryKey()` on `room_members`, populated with UUID v7 at insert time.
   - Add a table-level check constraint: the operator row has `agent_id IS NULL AND member = 'user'`; the agent row has `agent_id IS NOT NULL` via SQL `CHECK ((agent_id IS NULL AND member = 'user') OR agent_id IS NOT NULL)`.
   - Will add the partial unique indexes in the hand-written migration in step 7, since Drizzle's schema DSL does not fluently express partial indexes.

7. Generate a draft migration: `cd server && npx drizzle-kit generate`. It will produce `server/drizzle/0002_*.sql`. Inspect the draft. It will almost certainly not produce a safe rewrite order; discard the body and replace it by hand-writing the migration from scratch in the same file. Write the hand-rolled SQL in this exact order:
   - `DELETE FROM` every table that holds rows whose referential integrity cannot be resolved. In practice, because this is a local PGlite dev DB and agent rows are session-scoped, the simplest correct approach is a full wipe: `DELETE FROM room_members; DELETE FROM rooms; DELETE FROM team_members; DELETE FROM teams; DELETE FROM chat_messages; DELETE FROM messages; DELETE FROM task_files; DELETE FROM task_dependencies; DELETE FROM tasks; DELETE FROM files; DELETE FROM build_history; DELETE FROM ubt_queue; DELETE FROM ubt_lock; DELETE FROM agents;` (order: children before parents). Live containers repopulate agents on next register.
   - `ALTER TABLE agents DROP CONSTRAINT agents_pkey;` then `ALTER TABLE agents ADD COLUMN id text; UPDATE agents SET id = ...` — skip the UPDATE because the wipe above leaves the table empty. Then `ALTER TABLE agents ADD PRIMARY KEY (id); ALTER TABLE agents ADD CONSTRAINT agents_project_name_unique UNIQUE (project_id, name);`.
   - For each FK-carrying table, `ALTER TABLE <t> DROP COLUMN <old_name>; ALTER TABLE <t> ADD COLUMN <new_name> text REFERENCES agents(id);` — the tables are empty so there is no backfill.
   - For `project_id` FK adoption: `ALTER TABLE <t> ALTER COLUMN project_id DROP DEFAULT; ALTER TABLE <t> ADD CONSTRAINT <t>_project_fk FOREIGN KEY (project_id) REFERENCES projects(id);` for all 9 tables.
   - For `room_members`: drop PK, add `id text PRIMARY KEY`, add `agent_id text REFERENCES agents(id)`, add the CHECK constraint, and create the two partial unique indexes: `CREATE UNIQUE INDEX room_members_agent_unique ON room_members(room_id, agent_id) WHERE agent_id IS NOT NULL;` and `CREATE UNIQUE INDEX room_members_operator_unique ON room_members(room_id) WHERE agent_id IS NULL;`.
   - For `team_members`: drop the old composite PK, add the new composite PK on `(team_id, agent_id)`.
   - The migration ends with a `COMMIT;` if PGlite needs it explicit (check `0000_past_luke_cage.sql` and `0001_worried_marvex.sql` for the idiom used in this repo).

8. Run `cd server && npm run db:migrate` against the local PGlite data dir. If it errors, read the error carefully — PGlite's Postgres subset may reject a specific DDL form (partial indexes, CHECK constraints with OR). If a form is rejected, substitute with the narrowest equivalent that works. Do not silently weaken the schema. If partial indexes are rejected entirely, fall back to a trigger-based uniqueness enforcement and note this as a PGlite limitation in the plan's acceptance criteria.

9. Edit `server/src/queries/agents.ts`. Apply every change in this step before moving to step 10:
   - Import `v7 as uuidv7` from `uuid` at the top.
   - Add a required `projectId: string` parameter immediately after `db` to every exported function that takes a `name`: `getByName`, `updateStatus`, `softDelete`, `getWorktreeInfo`. Rewrite where-clauses as `and(eq(agents.projectId, projectId), eq(agents.name, name))`.
   - Delete `getProjectId(db, name)` entirely. Its semantics are ambiguous post-scoping; callers must use `request.projectId`.
   - Delete `hardDelete(db, name)`. Soft-delete replaces it. If a future vacuum tool needs raw delete, it will be a new function explicitly named `vacuumDeleteAgent` or similar.
   - Delete `deleteAll(db)`. It is unsafe cross-project. Replace with `deleteAllForProject(db, projectId)` that soft-deletes (sets status to `'deleted'`) every non-deleted agent in the project, returning the count.
   - Rewrite `softDelete` to set `status = 'deleted'` (not `'stopping'`). The stopping-status semantics move to the `stopAgent` function created in the next substep.
   - Add a new `stopAgent(db, projectId, name)` function that sets `status = 'stopping'`. This preserves the existing `_watch_for_stop` polling behavior in containers — the server-side state that a running container polls against must remain `stopping`, not `deleted`, so that the container knows it was asked to stop and can run its own shutdown sequence before its row is soft-deleted.
   - Rewrite `register()`:
     - Generate a UUID v7 via `uuidv7()` for new rows.
     - Change the upsert target to `[agents.projectId, agents.name]`.
     - On conflict, keep the existing `id` (do not regenerate — this is the "same identity across reconnects" guarantee). In Drizzle, this is expressed as `onConflictDoUpdate({ target: [agents.projectId, agents.name], set: { ...fields, status: 'idle', sessionToken, registeredAt: sql\`now()\`, containerHost: sql\`COALESCE(excluded.container_host, ${agents.containerHost})\` } })` — omitting `id` and `projectId` from the set clause. Confirm that Drizzle's ON CONFLICT on a composite unique constraint works in PGlite; if it does not, fall back to a SELECT-then-INSERT/UPDATE in a transaction.
     - The returned `sessionToken` remains the rotating per-session identifier as before.
   - Rewrite `getActiveNames(db, projectId)` with a required `projectId` and the clause `and(ne(agents.status, 'stopping'), ne(agents.status, 'deleted'), eq(agents.projectId, projectId))`. Deleted agents are not "active" by any definition.
   - Add a new `getByIdInProject(db, projectId, id)` helper for callers that hold a UUID and want to verify it still belongs to the expected project.

10. Edit `server/src/queries/tasks-lifecycle.ts`. Add a required `projectId: string` to `releaseByAgent` and `releaseAllActive`. The `releaseByAgent` function also needs to accept an `agentId: string` (UUID) instead of the old `agent: string` name — the text agent name no longer exists on tasks. Rewrite each where-clause to match on `tasks.claimedByAgentId` and add `eq(tasks.projectId, projectId)`.

11. Edit `server/src/queries/files.ts`. Apply the same transformation to `releaseByClaimant` (now `releaseByClaimantAgentId`) and `releaseAll`. Both take `projectId`; the former also takes `agentId`. Queries match on `files.claimantAgentId` and `files.projectId`.

12. Edit `server/src/queries/coalesce.ts`. Its `pausePumpAgents`, `countActiveTasksForAgent`, and `getOwnedFiles` functions all accept `agent: string` today. Change `agent: string` to `agentId: string` wherever it refers to a specific agent, and use the UUID column in where-clauses. `pausePumpAgents(db, projectId?)` already takes an optional `projectId`; tighten it to required.

13. Edit `server/src/queries/ubt.ts`. Grep for `agents.name` and `holder` references. `ubtLock.holder` and `ubtQueue.agent` are now `holderAgentId` and `agentId`. Update all query writers and readers. The 60-second stale-lock sweep (referenced in `CLAUDE.md`) uses a JOIN on `agents` — ensure the JOIN is on `agents.id = ubt_lock.holder_agent_id`, not on name.

14. Edit `server/src/routes/agents.ts`:
   - Every `agentsQ.*(db, name)` call becomes `agentsQ.*(db, request.projectId, name)`.
   - `POST /agents/register` (line 44) must generate and insert a UUID v7 `id` for new agents. Drizzle does not auto-populate `id` because it has no default. Either generate it in `register()` in `queries/agents.ts` (chosen — already specified in step 9), or explicitly pass it from the route. Keep the generation in `queries/agents.ts` for single-source-of-truth.
   - `DELETE /agents/:name` (lines 120–146): rescope by `request.projectId`; call `softDelete` (which now sets `'deleted'`) instead of `hardDelete`; pass `request.projectId` to `releaseByClaimantAgentId` and `releaseByAgent` (which now take `agentId` — look up the agent first to get its UUID). Also accept an optional `sessionToken` query parameter; if provided and it does not match `agent.sessionToken`, return `409 Conflict` with body `{ error: 'session token mismatch — another container has taken over this agent slot' }`. If the `sessionToken` query parameter is absent, skip the check (preserves operator and dashboard compatibility).
   - Remove the "first call vs second call" two-phase delete logic at lines 130–146. Under soft-delete semantics, the flow is simpler: flip status to `'deleted'`, release transient claims, return `{ ok: true, deleted: true }`. There is no "hard delete on second call" — the row lives until vacuum.
   - `DELETE /agents` (bulk, lines 148–158): replace with a soft-delete bulk op scoped to `request.projectId`. Call the new `deleteAllForProject` and the project-scoped `releaseAllActive`.
   - `POST /agents/:name/sync` (line 161): pass `request.projectId` to `getWorktreeInfo`.
   - `POST /agents/:name/status` (line 102): pass `request.projectId` to `updateStatus`. Validate the incoming status against the allowed set (`idle`, `working`, `done`, `error`, `paused`, `stopping` — not `deleted`, to prevent clients from soft-deleting via the status endpoint). Return `400 Bad Request` on unknown or forbidden values.

15. Grep for every remaining caller of a renamed function or removed function. Targets: `agentsQ.getProjectId`, `agentsQ.hardDelete`, `agentsQ.deleteAll`, `agentsQ.releaseByAgent` (the parameter change), all `agent` columns renamed to `agentId`. Files previously identified: `server/src/git-utils.ts` (uses `getActiveNames`), `server/src/routes/build.ts` (uses `getProjectId` and `getWorktreeInfo`), `server/src/routes/tasks-claim.ts` (uses `getWorktreeInfo` and `getProjectId`), `server/src/routes/teams.ts` and `server/src/queries/teams.ts` (team_members schema change). Update each to:
   - Pass `request.projectId` from the Fastify request.
   - Replace any `getProjectId` call with the existing `request.projectId`.
   - Convert agent-name string references to agent UUID references by adding a `getByName → .id` lookup at the call site.

16. Edit `container/lib/registration.sh`:
   - The existing `SESSION_TOKEN` export from `_register_agent` (line 164) is already present. Keep it.
   - In `_shutdown` (line 102): when calling `DELETE /agents/${AGENT_NAME}`, append `?sessionToken=${SESSION_TOKEN}` to the URL. Use a simple regex check (`[[ "$SESSION_TOKEN" =~ ^[0-9a-f]{32}$ ]]`) — the server generates tokens as 32 hex chars via `randomBytes(16).toString('hex')` in `server/src/routes/agents.ts:50`, so no URL encoding is needed, and rejecting malformed values prevents injection.
   - The existing `_post_status "error"` and similar calls do not need changes. The POST /agents/:name/status endpoint will now reject the value `'deleted'` from clients (step 14); no container code currently sends that value.

17. Update `server/src/queries/agents.test.ts` and `server/src/routes/agents.test.ts`:
   - Every `register()` call must be checked against the new return shape (it now populates `id`).
   - Every call to a query function must pass explicit `projectId`.
   - Tests that relied on the implicit `'default'` project_id via the column default will fail — make the project explicit.
   - Tests that asserted `hardDelete` removes the row must be rewritten to assert that `softDelete` sets `status = 'deleted'` and leaves the row present.
   - Tests that asserted the two-phase DELETE (first call sets stopping, second hard-deletes) must be rewritten to the new single-phase soft-delete.
   - Add a new regression test block in `routes/agents.test.ts`:
     - Register `agent-1` in project `alpha` and `agent-1` in project `beta`. Assert both rows exist with different `id` values and the correct `project_id` values.
     - Claim a task in project `beta` with `agent-1`. Send `DELETE /agents/agent-1` with header `X-Project-Id: alpha`. Assert the task in project `beta` is still `in_progress`.
     - Register `agent-1` in project `alpha`, capture `sessionToken`. Send `DELETE /agents/agent-1?sessionToken=deadbeef00000000deadbeef00000000` with header `X-Project-Id: alpha`. Assert `409`. Send without `sessionToken`. Assert `200` and that the row's status is `'deleted'`. Send a second DELETE without `sessionToken` — assert it is idempotent (or that it returns `200` without changing state, whichever the handler implements).
     - Register `agent-1` in project `alpha`, soft-delete it, then register `agent-1` in project `alpha` again. Assert the `id` is unchanged and the status is back to `'idle'`. This is the reactivation semantics test.

18. Update `server/src/queries/tasks-lifecycle.test.ts`, `server/src/queries/files.test.ts`, `server/src/queries/ubt.test.ts`, `server/src/queries/coalesce.test.ts`, and any other query test files. Each gains explicit `projectId` arguments and agent-by-UUID references. Tests that were relying on text agent names in claim/release round-trips need the UUID inserted after the `register()` call.

19. Update `server/src/routes/tasks.test.ts`, `server/src/routes/build.test.ts`, `server/src/routes/ubt.test.ts`, `server/src/routes/coalesce.test.ts`. Same transformation — explicit projectId in setup, register agents properly to get a UUID, reference agents by id.

20. Run `cd server && npm run typecheck`. Fix type errors until clean. Expect a large error fan-out; the removal of `getProjectId` and `hardDelete` will surface at every call site, and the column renames will surface in every query. Do not move on until typecheck is green.

21. Run `cd server && npm test`. Fix test failures until clean. Do not move on until all tests pass.

22. Validate container shell syntax: `bash -n container/lib/registration.sh`. Fix any shell errors.

23. Update `CLAUDE.md` in the repo root:
    - In the "Server Code Conventions" section, add: agent identity is `agents.id` (UUID v7); `(project_id, name)` is a unique human-readable slot, not an identity. Every agent query must take an explicit `projectId`. Agents are soft-deleted via `status = 'deleted'`; hard deletion is a vacuum-class operation not performed in normal flow.
    - Under the `/agents/*` route listing, update the DELETE route description to reflect soft-delete semantics and the optional `sessionToken` query parameter.
    - Under the coordination server summary, add a note that FK constraints now enforce cross-table integrity and that `project_id` is a foreign key to `projects.id` on every data table.

24. Delete `plans/project-id-foreign-keys.md` — it is fully absorbed into this plan. Add a note to `plans/schema-hardening-v25.md`'s "Context" section that this happened, so the decision is recoverable from the plan alone.

25. Delete the scratch audit file `plans/schema-hardening-v25-audit.md` created in step 2. Its content informed steps 9–15 and is no longer needed.

26. Final commit. Stage all the touched files, commit with a message referencing this plan by filename.

27. Operator-run rebuild and smoke test (required — the orchestrator cannot rebuild Docker from inside a container):
    - `cd container && docker compose build` on the agent image.
    - Bring down any existing containers with `./stop.sh`.
    - Wipe the local PGlite data dir (migration is destructive; on a merged branch this is a one-time operator action).
    - Restart the coordination server: `cd server && npm run dev`.
    - `./launch.sh --project <id-A> --agent-name agent-1 --fresh` in project A.
    - `./launch.sh --project <id-B> --agent-name agent-1 --fresh` in project B (intentionally reusing the name).
    - Verify both containers register successfully. Check the dashboard or `GET /agents` in each project — assert each project sees its own `agent-1` with a distinct UUID.
    - Give each container a task to work on. Verify they can both claim and complete tasks without interference.
    - Let container A finish its tasks and enter pump-idle for ~20 minutes, triggering the "no claimable tasks" shutdown. Confirm:
      - Container A's row has `status = 'deleted'` after shutdown, not removed.
      - Container B's agent row is untouched.
      - Container B's active task (if any) is still `in_progress`.
      - Container B continues polling.
    - Re-launch `agent-1` in project A with `--fresh`. Assert the same UUID is reused (reactivation) and the row's status returns to `idle`.

## Acceptance criteria

- Two containers in different projects with the same agent name coexist without interfering at any stage of their lifetimes.
- `agents.id` is a UUID v7 stored as text, and is the sole primary key of the agents table.
- A unique constraint on `(project_id, name)` is enforced in the schema, including for soft-deleted rows.
- Every cross-table reference to an agent is a FK on `agents.id` with `ON DELETE RESTRICT`.
- Every data table's `project_id` is a FK on `projects.id` with `ON DELETE RESTRICT`.
- `agents.status` may take the value `'deleted'`. `DELETE /agents/:name` sets this value rather than removing the row.
- `DELETE /agents/:name` rejects mismatched `sessionToken` values with `409`.
- `DELETE /agents` (bulk) is scoped to the caller's `projectId` and is soft-delete.
- All tests in `server/src` pass.
- The regression tests added in step 17 pass.
- The operator smoke test in step 27 reproduces cross-project isolation and agent reactivation.
- `server/src/queries/agents.ts` exports no `getProjectId`, `hardDelete`, or `deleteAll`.
- `plans/project-id-foreign-keys.md` is deleted; its intent is documented in this plan.
- `CLAUDE.md` reflects the new invariants.

## Explicitly out of scope for this plan

- `agent_type` observability column on `agents`. Follow-up: simple ALTER TABLE.
- Vacuum / compaction tooling for truly removing soft-deleted agents and their historical references. Follow-up: a small CLI tool that takes a retention policy and a date cutoff, archives, and hard-deletes with cascades in a transaction.
- Dashboard UI changes to surface the `deleted` status. Follow-up: small UI update to show deleted agents in a "History" section.
- Any reconsideration of `messages.agent` if it turns out to be a display label rather than a referential pointer — that decision is made in step 5 based on the actual field semantics discovered during the audit in step 2. If the field turns out to need both, the plan adds a nullable FK column alongside the display text as explicitly noted.
