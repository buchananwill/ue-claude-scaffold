# Schema hardening V2.5 — surrogate agent PKs, full FKs, soft-delete

## Context

The multi-tenancy migration gave every data table a `project_id text` column but never upgraded the schema to treat `(project_id, name)` as load-bearing. `agents.name` is a global primary key (`server/src/schema/tables.ts:19`), every cross-table reference to an agent is a plain text column without a constraint, and every `project_id` column lacks an FK to `projects`. The result was observed on 2026-04-08: `agent-1` in project A shut down during an idle pump timeout, its `_shutdown` called `DELETE /agents/agent-1` with no project scope, and the unconditional `tasksLifecycleQ.releaseByAgent('agent-1')` released an active task belonging to `agent-1` in project B.

This plan folds together three overdue repairs into one migration:

1. Surrogate UUID v7 primary key on `agents`, with `unique(project_id, name)`. Every cross-table reference to an agent becomes a single-column FK on the UUID.
2. Agent rows are never hard-deleted in normal operation. A new `status = 'deleted'` soft-delete state replaces row removal. Real purges become a rare vacuum-class operation, out of scope here. This eliminates audit trail corruption risk and removes any need for "name-at-time-of-write" denormalization on historical tables.
3. Full foreign key adoption across all 9 data tables — both `project_id` FKs to `projects` (absorbing `plans/project-id-foreign-keys.md` into this effort) and agent FKs throughout. `ON DELETE RESTRICT` is the default; the database itself enforces the integrity the application layer was supposed to but didn't.

All work lands on a single branch in a single container run. Merge once; revert whole if needed. No compatibility shims, no phased rollout, no backwards compatibility for old text references.

**Driver neutrality:** `server/src/drizzle-instance.ts` is already a dual-driver dispatch — node-postgres when `DATABASE_URL` is set (the path a future Supabase deployment takes), PGlite otherwise (local dev and tests). The schema module, migration files, and query code are shared. Every change in this plan applies identically to both drivers through the same `server/drizzle/*.sql` migration files. No driver switch is required for this work.

## Design decisions (locked — do not re-evaluate mid-execution)

**Surrogate PK type:** native `uuid` column named `id` on `agents`, holding a UUID v7 value generated application-side via the `uuid` npm package (v11+). Rationale: PGlite supports the native `uuid` type in core (verified: it stores as uuid, `pg_typeof` reports `uuid`, and format is enforced at insert). Real Postgres and Supabase support it trivially. Generation stays in JS — application-side for symmetry between drivers, and because PGlite has no `pg_uuidv7` extension. UUID v7 is time-ordered so B-tree index locality stays healthy.

**Soft-delete:** add the value `'deleted'` to the set of valid `agents.status` values. `status` remains `text` (no enum). The documented valid values become: `idle | working | done | error | paused | stopping | deleted`. `DELETE /agents/:name` flips `status` to `deleted` and releases transient claims (files, tasks, ubt locks) but leaves the row in place. The row's FK references from `messages`, `build_history`, etc. remain intact.

**Unique constraint on `(project_id, name)`:** enforced even for soft-deleted rows. A new container registering `agent-1` in a project where an older `agent-1` is in `status = 'deleted'` must either reject or deliberately reactivate the existing row. The register path will reactivate — flipping status back to `idle`, rotating `session_token`, and updating `container_host` — rather than inserting a new row. This prevents audit trail spoofing: the historical agent-1 is the same row, tracked continuously across its lifetime, never two distinct UUIDs.

**FK semantics:** `ON DELETE RESTRICT` for every FK added in this pass. `ON DELETE CASCADE` is reserved for the future vacuum tooling and is not used here. The only exception is `task_files` / `task_dependencies` within-table references, which were never broken and retain their existing `ON DELETE CASCADE` if any (verify during step 4).

**Name-at-time-of-write columns:** not added. Soft-delete obviates the need.

**`room_members` polymorphism (eliminated, not papered over):** audit of the codebase on 2026-04-08 revealed that the `room_members.member = 'user'` row is **write-only dead data**. It is inserted at two sites (`server/src/routes/agents.ts:74` direct-room creation, `server/src/queries/teams.ts:64` team room creation) and is never read — the dashboard fetches rooms by project without filtering on membership (`dashboard/src/hooks/useRooms.ts:12`), and no server query joins on `member = 'user'`. The operator is *not* actually a participant in the room — they are an author of some messages and a viewer of all rooms on the local server.

Accordingly, `room_members` becomes **agent-only**:
```
room_members (
  id           uuid primary key,
  room_id      text not null references rooms(id) on delete restrict,
  agent_id     uuid not null references agents(id) on delete restrict,
  joined_at    timestamp default now(),
  unique (room_id, agent_id)
)
```
No CHECK constraint. No partial unique indexes. No nullable FK. No polymorphism. No `member` text column. The two `'user'` insert sites are deleted outright as dead code.

The operator's authorship of messages is instead expressed on `chat_messages` via a typed discriminator:
```
chat_messages (
  id                 serial primary key,  -- unchanged
  room_id            text not null references rooms(id) on delete restrict,
  author_type        text not null check (author_type in ('agent', 'operator', 'system')),
  author_agent_id    uuid references agents(id) on delete restrict,
  content            text not null,
  reply_to           integer references chat_messages(id) on delete set null,
  created_at         timestamp default now(),
  check (
    (author_type = 'agent' and author_agent_id is not null)
    or (author_type in ('operator', 'system') and author_agent_id is null)
  )
)
```
The old `sender text` column is replaced by `author_type` + `author_agent_id`. For agent messages, the server resolves the display name via a join to `agents.name`. For operator and system messages, the display name is a constant ("user" or "system") rendered by the server response layer.

This separates two orthogonal concerns the old schema was conflating: *room membership* (who is a participant) and *message authorship* (who wrote this). Agents are both. The operator is only the latter.

**`agent_type` column on `agents`:** out of scope for this plan. Listed as a follow-up in the acceptance section. Adding it later is a simple column addition and does not require another schema rewrite.

**Historical data:** preserved via a staged backfill migration (detailed in step 7). The migration file runs identically on PGlite (local) and node-postgres/Supabase (future hosted), so the data-preservation semantics must be correct for both. Wiping is not acceptable — a destructive migration file becomes a permanent landmine in the migration history.

**Orphan handling policy** — the current schema has no FK integrity, so any migration that adds FKs will find dangling references (agent names that were hard-deleted, cross-project name collisions from the PK bug, `project_id = 'default'` values with no matching project). The policy per table is:

- **Live-state orphans** (`tasks.claimed_by`, `files.claimant`, `ubt_lock.holder`, `ubt_queue.agent`): NULL out the claim / delete the lock / delete the queue entry. The referenced work becomes unclaimed and re-queueable. No data loss that matters — these are transient claims.
- **Membership orphans** (`team_members.agent_name`, `room_members.member` where `member != 'user'`): DELETE the membership row. Empty team or empty agent-side room membership is recoverable; a dangling reference is not.
- **Historical orphans** (`messages.agent`, `build_history.agent`): **keep the row**. Add the new nullable `agent_id uuid` column, leave it NULL for orphaned rows, and retain the old `agent text` column on these two tables as a display-only legacy field. This preserves the audit trail. New rows going forward populate `agent_id`; the old text column becomes redundant for new writes but stays valid for old writes. This is the one exception to the "drop old columns" pattern in step 7.
- **`project_id` orphans**: absorbs the cleanup logic from `plans/project-id-foreign-keys.md`. Rows with `project_id = 'default'` (or any other unknown project) in child tables get DELETEd in the same order specified by that plan before the `project_id` FK constraints are added. `agents` rows with unknown `project_id` get soft-deleted to `status = 'deleted'` rather than removed, so any historical references survive.

All orphan counts are logged before deletion so the operator can eyeball what is about to happen when the migration runs.

## Execution order

1. `cd server && npm install uuid@^11` to add the UUID v7 generator. Confirm `@types/uuid` is bundled or install separately if not.

2. Audit current usage of each cross-table reference. Run a grep for each of: `tasks.claimedBy`, `files.claimant`, `builds.agent` (in `buildHistory`), `ubtLock.holder`, `ubtQueue.agent`, `messages.agent`, `roomMembers.member`, `teamMembers.agentName`. For each, catalogue (a) the column's current name in `tables.ts`, (b) every query file that reads or writes it, and (c) every test file that exercises it. The result is a work list consumed by steps 9–15. Write the audit results as scratch text into `plans/schema-hardening-v25-audit.md` and commit it alongside the plan. Delete the audit file before the final merge.

3. Edit `server/src/schema/tables.ts`, working top-to-bottom. Ensure `uuid` is imported from `drizzle-orm/pg-core` alongside the existing `text`, `integer`, `timestamp`, etc. imports. For the `agents` table:
   - Add `id: uuid('id').primaryKey()` as the first field.
   - Remove `.primaryKey()` from the existing `name: text('name')` declaration.
   - Leave `project_id text notNull` as is for now (the `.references(...)` call comes in step 4).
   - Add a table-level `unique('agents_project_name_unique').on(table.projectId, table.name)` using the `(table) => [...]` callback form.
   - Add the `deleted` status to any inline comment enumerating valid statuses.
   - Ensure `sessionToken` still has `.unique()` (it should — do not remove).

4. Still in `tables.ts`, add `.references(() => projects.id)` on `project_id` in all 9 data tables (agents, ubtLock, ubtQueue, buildHistory, messages, tasks, files, rooms, teams). Drop the `.default('default')` on each — the default-`default` behavior was a prototype holdover, and the FK makes an implicit default unsafe. Tests that relied on the default must pass an explicit `projectId`.

5. Still in `tables.ts`, replace every text column that references an agent by name with a `uuid` FK to `agents.id`. Specifically:
   - `tasks.claimedBy` (`text`, nullable) → rename to `claimedByAgentId uuid REFERENCES agents(id) ON DELETE RESTRICT`, nullable.
   - `files.claimant` (`text`, nullable) → rename to `claimantAgentId uuid REFERENCES agents(id) ON DELETE RESTRICT`, nullable.
   - `buildHistory.agent` (`text`, not nullable) → rename to `agentId uuid REFERENCES agents(id) ON DELETE RESTRICT`, not nullable.
   - `ubtLock.holder` (`text`, nullable — it is released) → rename to `holderAgentId uuid REFERENCES agents(id) ON DELETE RESTRICT`, nullable.
   - `ubtQueue.agent` (`text`, not nullable) → rename to `agentId uuid REFERENCES agents(id) ON DELETE RESTRICT`, not nullable.
   - `messages.agent` — this is a historical audit trail column. Per the orphan policy, **keep the old `agent text` column** as a display-only legacy field and add a new nullable `agentId uuid REFERENCES agents(id) ON DELETE RESTRICT` column alongside it. The new column is populated for new writes; the old column is retained to preserve audit history for pre-migration rows. Same treatment for `build_history.agent` — add nullable `agentId` alongside the existing `agent` text column, keep both.
   - `teamMembers.agentName` → rename to `agentId uuid REFERENCES agents(id) ON DELETE RESTRICT`, and update the composite PK on `(team_id, agent_name)` to `(team_id, agent_id)`.

6. Still in `tables.ts`, apply the **agent-only `room_members`** change and the **`chat_messages` authorship discriminator**:
   - For `room_members`:
     - Add `id: uuid('id').primaryKey()` as the first field.
     - Remove the old `member` text column entirely.
     - Remove the old composite PK on `(room_id, member)`.
     - Add `agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'restrict' })`.
     - Add a table-level `unique('room_members_room_agent_unique').on(table.roomId, table.agentId)` using the `(table) => [...]` callback form.
     - Keep `joinedAt` as is.
   - For `chat_messages`:
     - Remove the old `sender text notNull` column entirely.
     - Add `authorType: text('author_type').notNull()` — values restricted to `'agent'`, `'operator'`, `'system'`. Enforcement via CHECK constraint added in the migration step 7 (Drizzle DSL does not express CHECK constraints fluently).
     - Add `authorAgentId: uuid('author_agent_id').references(() => agents.id, { onDelete: 'restrict' })` — nullable. Populated only when `authorType === 'agent'`.
     - The table-level CHECK `(authorType = 'agent' AND authorAgentId IS NOT NULL) OR (authorType IN ('operator', 'system') AND authorAgentId IS NULL)` is added in the migration, not in the Drizzle schema.
     - Keep `roomId`, `content`, `replyTo`, `createdAt`, and the existing `id serial primary key` unchanged.

7. Generate a draft migration: `cd server && npx drizzle-kit generate`. It will produce `server/drizzle/0002_*.sql`. Inspect the draft — it will be uninformed about orphan handling, column swap ordering, and the historical-tables exception, so discard the body and replace it with three hand-written migration files that run in order. All three are pure SQL, no JS interleaving required, because PGlite supports `gen_random_uuid()` natively (verified on 2026-04-08 via probe: `SELECT gen_random_uuid()` returns a valid uuid string). `gen_random_uuid()` produces v4, not v7 — this is acceptable for migration backfill because the pre-existing agent rows do not need time-ordered IDs retroactively. New agents created after the migration use JS-side UUID v7 via the `uuid` npm package (step 9).

   **File `server/drizzle/0002_add_columns.sql`** — additive only, no drops, no constraints. Goal: create the new columns alongside the old ones without breaking anything.
   ```sql
   -- Add agents.id as nullable uuid, populate for existing rows
   ALTER TABLE agents ADD COLUMN id uuid;
   UPDATE agents SET id = gen_random_uuid() WHERE id IS NULL;
   -- Cannot add PK or NOT NULL yet — must resolve duplicate (project_id, name) first in file 0003

   -- Add new FK columns on every referring table, all nullable for now
   ALTER TABLE tasks ADD COLUMN claimed_by_agent_id uuid;
   ALTER TABLE files ADD COLUMN claimant_agent_id uuid;
   ALTER TABLE build_history ADD COLUMN agent_id uuid;
   ALTER TABLE ubt_lock ADD COLUMN holder_agent_id uuid;
   ALTER TABLE ubt_queue ADD COLUMN agent_id uuid;
   ALTER TABLE messages ADD COLUMN agent_id uuid;
   ALTER TABLE team_members ADD COLUMN agent_id uuid;

   -- room_members: add surrogate id and agent_id. The old `member` text column
   -- stays for now; it will be dropped in 0004 after orphan cleanup in 0003.
   ALTER TABLE room_members ADD COLUMN id uuid;
   UPDATE room_members SET id = gen_random_uuid() WHERE id IS NULL;
   ALTER TABLE room_members ADD COLUMN agent_id uuid;

   -- chat_messages: add author_type discriminator and author_agent_id FK column.
   -- The old `sender` text column stays for now; it will be dropped in 0004.
   ALTER TABLE chat_messages ADD COLUMN author_type text;
   ALTER TABLE chat_messages ADD COLUMN author_agent_id uuid;

   -- agents: add the 'deleted' status column semantics — no schema change needed,
   -- status is already text; 'deleted' becomes a valid value by convention.
   ```

   **File `server/drizzle/0003_backfill_and_orphans.sql`** — backfill the new columns from the old text references, handle orphans per policy, resolve duplicate `(project_id, name)` in agents.
   ```sql
   -- STEP 1: Resolve duplicate (project_id, name) in agents before adding unique constraint.
   -- The PK bug allowed ON CONFLICT (name) DO UPDATE to overwrite rows; any residual
   -- duplicates in the live DB would block the new unique constraint. Soft-delete all but
   -- the most recently registered row per (project_id, name).
   UPDATE agents SET status = 'deleted' WHERE id IN (
     SELECT id FROM (
       SELECT id, ROW_NUMBER() OVER (
         PARTITION BY project_id, name ORDER BY registered_at DESC NULLS LAST
       ) AS rn
       FROM agents
     ) ranked WHERE rn > 1
   );

   -- STEP 2: Backfill task.claimed_by_agent_id from agents(project_id, name).
   -- Live-state orphan policy: NULL the claim, reset status to pending.
   UPDATE tasks SET claimed_by_agent_id = a.id
   FROM agents a
   WHERE tasks.claimed_by = a.name AND tasks.project_id = a.project_id;

   UPDATE tasks SET
     claimed_by = NULL,
     claimed_at = NULL,
     status = 'pending'
   WHERE claimed_by IS NOT NULL AND claimed_by_agent_id IS NULL
     AND status IN ('claimed', 'in_progress');

   -- STEP 3: Backfill files.claimant_agent_id. Live-state orphan policy: NULL the claim.
   UPDATE files SET claimant_agent_id = a.id
   FROM agents a
   WHERE files.claimant = a.name AND files.project_id = a.project_id;

   UPDATE files SET claimant = NULL, claimed_at = NULL
   WHERE claimant IS NOT NULL AND claimant_agent_id IS NULL;

   -- STEP 4: Backfill ubt_lock.holder_agent_id. Live-state orphan policy: release the lock.
   UPDATE ubt_lock SET holder_agent_id = a.id
   FROM agents a
   WHERE ubt_lock.holder = a.name;

   UPDATE ubt_lock SET holder = NULL, acquired_at = NULL, priority = 0
   WHERE holder IS NOT NULL AND holder_agent_id IS NULL;

   -- STEP 5: Backfill ubt_queue.agent_id. Live-state orphan policy: DELETE the row.
   UPDATE ubt_queue SET agent_id = a.id
   FROM agents a
   WHERE ubt_queue.agent = a.name;

   DELETE FROM ubt_queue WHERE agent_id IS NULL;

   -- STEP 6: Backfill team_members.agent_id. Membership orphan policy: DELETE the row.
   UPDATE team_members SET agent_id = a.id
   FROM agents a, teams t
   WHERE team_members.agent_name = a.name
     AND team_members.team_id = t.id
     AND t.project_id = a.project_id;

   DELETE FROM team_members WHERE agent_id IS NULL;

   -- STEP 7: Backfill room_members.agent_id. Under Option D, room_members
   -- becomes agent-only. Operator rows (member = 'user') are dead write-only
   -- data — the dashboard does not read them and no server query joins on them.
   -- Policy: DELETE all operator rows outright, DELETE agent rows that failed to
   -- resolve to a valid agents(id).
   UPDATE room_members SET agent_id = a.id
   FROM agents a, rooms r
   WHERE room_members.member = a.name
     AND room_members.room_id = r.id
     AND r.project_id = a.project_id
     AND room_members.member != 'user';

   DELETE FROM room_members WHERE member = 'user';
   DELETE FROM room_members WHERE agent_id IS NULL;

   -- STEP 7b: Backfill chat_messages.author_type and author_agent_id from the
   -- old `sender` column. Agents resolved by name; unknown senders and the
   -- literal 'user' become operator / system messages.
   UPDATE chat_messages cm SET
     author_type = 'agent',
     author_agent_id = a.id
   FROM agents a, rooms r
   WHERE cm.sender = a.name
     AND cm.room_id = r.id
     AND r.project_id = a.project_id
     AND cm.sender != 'user';

   -- Operator messages: any row with sender = 'user' (the team-launcher and
   -- dashboard default) becomes author_type = 'operator' with NULL author_agent_id.
   UPDATE chat_messages SET author_type = 'operator'
   WHERE sender = 'user' AND author_type IS NULL;

   -- Historical orphan policy for chat_messages: any row whose old `sender`
   -- referenced a since-deleted agent is classified as 'system'. The original
   -- sender name is lost, which is acceptable for a handful of pre-migration
   -- orphan rows in a local dev DB. Message content often self-identifies the
   -- author, so this is not a hard audit-trail loss.
   UPDATE chat_messages SET author_type = 'system'
   WHERE author_type IS NULL;

   -- STEP 8: Backfill messages.agent_id. Historical orphan policy: KEEP the row, leave agent_id NULL.
   -- The existing messages.agent text column remains as a display-only legacy field.
   -- Only applies if messages.agent is actually a referential column per the audit in step 2.
   UPDATE messages SET agent_id = a.id
   FROM agents a
   WHERE messages.agent = a.name AND messages.project_id = a.project_id;
   -- No orphan cleanup — NULLs are expected and retained.

   -- STEP 9: Backfill build_history.agent_id. Historical orphan policy: KEEP the row, leave agent_id NULL.
   UPDATE build_history SET agent_id = a.id
   FROM agents a
   WHERE build_history.agent = a.name AND build_history.project_id = a.project_id;

   -- STEP 10: Clean up project_id orphans per plans/project-id-foreign-keys.md logic.
   -- Delete rows in child tables whose project_id has no matching projects.id row.
   -- Order: children before parents. See the absorbed plan for the exact sequence.
   DELETE FROM team_members WHERE team_id IN (
     SELECT id FROM teams WHERE project_id NOT IN (SELECT id FROM projects)
   );
   DELETE FROM teams WHERE project_id NOT IN (SELECT id FROM projects);

   DELETE FROM room_members WHERE room_id IN (
     SELECT id FROM rooms WHERE project_id NOT IN (SELECT id FROM projects)
   );
   DELETE FROM chat_messages WHERE room_id IN (
     SELECT id FROM rooms WHERE project_id NOT IN (SELECT id FROM projects)
   );
   DELETE FROM rooms WHERE project_id NOT IN (SELECT id FROM projects);

   DELETE FROM task_files WHERE task_id IN (
     SELECT id FROM tasks WHERE project_id NOT IN (SELECT id FROM projects)
   );
   DELETE FROM task_dependencies WHERE task_id IN (
     SELECT id FROM tasks WHERE project_id NOT IN (SELECT id FROM projects)
   ) OR depends_on IN (
     SELECT id FROM tasks WHERE project_id NOT IN (SELECT id FROM projects)
   );
   DELETE FROM tasks WHERE project_id NOT IN (SELECT id FROM projects);

   DELETE FROM files WHERE project_id NOT IN (SELECT id FROM projects);
   DELETE FROM build_history WHERE project_id NOT IN (SELECT id FROM projects);
   DELETE FROM messages WHERE project_id NOT IN (SELECT id FROM projects);
   DELETE FROM ubt_queue WHERE project_id NOT IN (SELECT id FROM projects);
   DELETE FROM ubt_lock WHERE project_id NOT IN (SELECT id FROM projects);

   -- agents: soft-delete rather than remove, to preserve historical references
   UPDATE agents SET status = 'deleted'
   WHERE project_id NOT IN (SELECT id FROM projects);
   ```

   **File `server/drizzle/0004_constraints_and_swap.sql`** — add every constraint, drop old columns (except the two historical exceptions), finalize the schema.
   ```sql
   -- agents: swap PK
   ALTER TABLE agents ALTER COLUMN id SET NOT NULL;
   ALTER TABLE agents DROP CONSTRAINT agents_pkey;
   ALTER TABLE agents ADD CONSTRAINT agents_pkey PRIMARY KEY (id);
   ALTER TABLE agents ADD CONSTRAINT agents_project_name_unique UNIQUE (project_id, name);

   -- FK constraints on every referring table
   ALTER TABLE tasks ADD CONSTRAINT tasks_claimed_by_agent_fk
     FOREIGN KEY (claimed_by_agent_id) REFERENCES agents(id) ON DELETE RESTRICT;
   ALTER TABLE files ADD CONSTRAINT files_claimant_agent_fk
     FOREIGN KEY (claimant_agent_id) REFERENCES agents(id) ON DELETE RESTRICT;
   ALTER TABLE build_history ADD CONSTRAINT build_history_agent_fk
     FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE RESTRICT;
   ALTER TABLE ubt_lock ADD CONSTRAINT ubt_lock_holder_agent_fk
     FOREIGN KEY (holder_agent_id) REFERENCES agents(id) ON DELETE RESTRICT;
   ALTER TABLE ubt_queue ADD CONSTRAINT ubt_queue_agent_fk
     FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE RESTRICT;
   ALTER TABLE messages ADD CONSTRAINT messages_agent_fk
     FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE RESTRICT;
   ALTER TABLE team_members ADD CONSTRAINT team_members_agent_fk
     FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE RESTRICT;
   ALTER TABLE room_members ADD CONSTRAINT room_members_agent_fk
     FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE RESTRICT;

   -- project_id FKs on all 9 data tables (absorbs plans/project-id-foreign-keys.md)
   ALTER TABLE agents ALTER COLUMN project_id DROP DEFAULT;
   ALTER TABLE agents ADD CONSTRAINT agents_project_fk
     FOREIGN KEY (project_id) REFERENCES projects(id);
   ALTER TABLE tasks ALTER COLUMN project_id DROP DEFAULT;
   ALTER TABLE tasks ADD CONSTRAINT tasks_project_fk
     FOREIGN KEY (project_id) REFERENCES projects(id);
   -- ... repeat for files, messages, build_history, ubt_queue, ubt_lock, rooms, teams

   -- NOT NULL on FK columns whose old text column was NOT NULL
   ALTER TABLE build_history ALTER COLUMN agent_id SET NOT NULL;
   ALTER TABLE ubt_queue ALTER COLUMN agent_id SET NOT NULL;
   ALTER TABLE team_members ALTER COLUMN agent_id SET NOT NULL;
   -- ubt_lock.holder was nullable (released lock), tasks.claimed_by was nullable,
   -- files.claimant was nullable, messages.agent may have been nullable — leave these.

   -- team_members: swap PK from (team_id, agent_name) to (team_id, agent_id)
   ALTER TABLE team_members DROP CONSTRAINT team_members_pkey;
   ALTER TABLE team_members ADD CONSTRAINT team_members_pkey PRIMARY KEY (team_id, agent_id);

   -- room_members: agent-only under Option D. Swap PK to surrogate id, enforce
   -- agent_id NOT NULL, add the (room_id, agent_id) unique constraint, drop the
   -- legacy `member` text column entirely.
   ALTER TABLE room_members ALTER COLUMN id SET NOT NULL;
   ALTER TABLE room_members ALTER COLUMN agent_id SET NOT NULL;
   ALTER TABLE room_members DROP CONSTRAINT room_members_pkey;
   ALTER TABLE room_members ADD CONSTRAINT room_members_pkey PRIMARY KEY (id);
   ALTER TABLE room_members ADD CONSTRAINT room_members_room_agent_unique
     UNIQUE (room_id, agent_id);
   ALTER TABLE room_members DROP COLUMN member;

   -- chat_messages: enforce the author_type discriminator and its CHECK.
   -- author_type is NOT NULL post-backfill; the CHECK enforces that agent
   -- messages have an author_agent_id and operator/system messages do not.
   ALTER TABLE chat_messages ALTER COLUMN author_type SET NOT NULL;
   ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_author_type_check
     CHECK (author_type IN ('agent', 'operator', 'system'));
   ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_author_agent_check
     CHECK (
       (author_type = 'agent' AND author_agent_id IS NOT NULL)
       OR (author_type IN ('operator', 'system') AND author_agent_id IS NULL)
     );
   ALTER TABLE chat_messages DROP COLUMN sender;

   -- Drop old text columns on LIVE-STATE tables (the ones where orphans were resolved).
   -- DO NOT drop the agent text column on messages or build_history — those stay as
   -- display-only legacy fields for historical audit trail preservation.
   ALTER TABLE tasks DROP COLUMN claimed_by;
   ALTER TABLE files DROP COLUMN claimant;
   ALTER TABLE ubt_lock DROP COLUMN holder;
   ALTER TABLE ubt_queue DROP COLUMN agent;
   ALTER TABLE team_members DROP COLUMN agent_name;
   -- messages.agent: KEEP (historical audit trail)
   -- build_history.agent: KEEP (historical audit trail)
   -- room_members.member: KEEP (operator discriminator, also legacy display name for agents)

   -- Drop agents_pkey_old / any leftover constraints if they exist.
   ```

   Verify the idiom used in `server/drizzle/0000_past_luke_cage.sql` and `server/drizzle/0001_worried_marvex.sql` for statement terminators and file-level comments, and match it in the three new files. Drizzle's migrator runs each file in one implicit transaction, so all statements in `0003_backfill_and_orphans.sql` either all apply or all roll back — this is the correctness guarantee. If a backfill step fails, the entire migration halts with the DB in its pre-0003 state (still dual-column, still functional under the pre-migration server code, but with 0002's additive columns present — the operator can then manually inspect, fix, and retry).

8. Before running the migration, capture a snapshot of the local PGlite data directory: `cp -r <pglite-data-dir> <pglite-data-dir>.backup-$(date +%Y%m%d-%H%M%S)`. This is the rollback path — if the migration corrupts something in a way the internal transaction rollback misses, the operator can restore the directory. Do not skip this step. For a future Supabase deployment, the equivalent is a `pg_dump` taken before applying the migration.

   Run `cd server && npm run db:migrate` against the local PGlite data dir. Read the output carefully. Expect log lines from each of the three migration files. If any step fails:
   - Inspect the error for the specific SQL statement that broke.
   - If the failure is orphan-related (e.g., a backfill UPDATE didn't cover a case), add a log statement to identify the unhandled row and fix the orphan policy in `0003_backfill_and_orphans.sql`. Retry by restoring the backup and rerunning.
   - If the failure is PGlite-specific (e.g., a DDL form it does not support), substitute with the narrowest equivalent. DDL features actually verified on PGlite on 2026-04-08: `gen_random_uuid()`, `UPDATE ... FROM`, partial unique indexes, CHECK constraints with OR expressions. All four are supported.
   - Do not silently weaken the schema. If a constraint can't be enforced, escalate to the operator.

   After a successful run, the schema is in its final state: `agents` has a UUID PK and `(project_id, name)` unique, every referring table has a proper FK on `agent_id`, every data table has a `project_id` FK, `room_members` has the polymorphism CHECK and partial indexes, and the live tables have had their old text columns dropped.

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

14. Edit `server/src/queries/rooms.ts`. Under Option D, `room_members` is agent-only and keyed on `agent_id uuid`, not `member text`. Apply the following changes:
    - `addMember(db, roomId, member: string)` → rename to `addMember(db, roomId: string, agentId: string)`. The body inserts `{ id: uuidv7(), roomId, agentId }`, relying on the `(room_id, agent_id)` unique constraint for deduplication via `.onConflictDoNothing({ target: [roomMembers.roomId, roomMembers.agentId] })`. Import `v7 as uuidv7` from `uuid` at the top.
    - `removeMember(db, roomId, member: string)` → rename to `removeMember(db, roomId: string, agentId: string)`. Where-clause becomes `and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId))`.
    - `getMembers(db, roomId)` → returns `Array<{ agentId: string; name: string }>`, joining `agents` to recover the display name. Query: `SELECT room_members.agent_id, agents.name FROM room_members INNER JOIN agents ON agents.id = room_members.agent_id WHERE room_members.room_id = $1 ORDER BY agents.name`.
    - `getPresence(db, roomId)` → join `agents` on `agents.id = room_members.agent_id` instead of the old name-match. Return shape stays the same (`{ name, joinedAt, online, status }`) but now sources `name` from `agents.name` and `status` from `agents.status`. The old LEFT JOIN becomes an INNER JOIN — there are no dangling members under the new FK. Deleted agents (`status = 'deleted'`) may still appear in presence; the server should filter them out or mark them as `status: 'deleted'` so the UI can decide. Recommendation: filter with `WHERE agents.status != 'deleted'`.
    - `listRooms(db, { member, projectId })` → change the filter. Under the new schema, the caller's "member" identity is their agent name + project id. Rewrite: when `opts.member` is present, resolve the agent via `(opts.projectId, opts.member) → agents.id` first, then JOIN `room_members` on `agent_id = <looked-up id>`. If no agent matches (unknown name or unknown project), return an empty list rather than 404 — preserves the MCP server's retry loop semantics. Do NOT fall back to name-matching. The `opts.member` parameter name stays the same for API compatibility with the existing HTTP route, but the semantic is now "look up an agent by this name in this project".

15. Edit `server/src/queries/chat.ts`. The `sender text` column on `chat_messages` is replaced by `authorType text` + `authorAgentId uuid`. Apply:
    - `SendMessageOpts` interface — replace `sender: string` with two fields: `authorType: 'agent' | 'operator' | 'system'` and `authorAgentId: string | null`.
    - `sendMessage(db, opts)` — insert `authorType` and `authorAgentId` explicitly. The CHECK constraint enforces the invariant; invalid combinations throw from the DB layer.
    - `getHistory(db, roomId, opts)` — the returned rows need a `sender` field for compatibility with the existing HTTP response shape (the MCP server reads `msg.sender` to display author names). Rewrite to LEFT JOIN `agents` on `agents.id = chat_messages.author_agent_id` and SELECT a computed `sender` field: `SELECT ..., COALESCE(agents.name, CASE chat_messages.author_type WHEN 'operator' THEN 'user' WHEN 'system' THEN 'system' END) AS sender FROM chat_messages LEFT JOIN agents ON agents.id = chat_messages.author_agent_id WHERE ...`. The `ORDER BY` and cursor logic on `chat_messages.id` is unchanged. This preserves the agent-visible HTTP response shape so no container code changes.
    - `isMember(db, roomId, member: string)` — this function is the membership check used by the message POST/GET handlers in `routes/rooms.ts:168,194`. Its semantics change meaningfully. Rename to `isAgentMember(db, roomId: string, agentId: string)` and rewrite the query to match on `room_members.agent_id = agentId`. The route-layer caller (step 16) is responsible for resolving the caller to an `agentId` first. The old string-match version is deleted.

16. Edit `server/src/routes/rooms.ts` — this is the integration point where the agent/operator split surfaces on the HTTP layer. Changes:
    - `POST /rooms/:id/messages` (line 141): the message author is determined as follows.
      - If `X-Agent-Name` header is present, resolve the agent by `(request.projectId, name)` via `agentsQ.getByName`. If not found, return `403 Forbidden` with body `{ error: 'unknown_agent' }`. If found, check `chatQ.isAgentMember(db, roomId, agent.id)`; on miss, return `403 not_a_member`. On hit, call `chatQ.sendMessage(db, { roomId, authorType: 'agent', authorAgentId: agent.id, content, replyTo })`.
      - If `X-Agent-Name` is absent, treat the request as an operator write. Skip the membership check entirely — the operator has implicit access to all rooms. Call `chatQ.sendMessage(db, { roomId, authorType: 'operator', authorAgentId: null, content, replyTo })`. The session-token fallback path (`routes/rooms.ts:151-156`) goes away — it was only a workaround for agents that couldn't set `X-Agent-Name`, and with the composite-key migration that workaround is no longer useful. If `X-Agent-Name` is genuinely unavailable and the caller is not the operator, the request is malformed and should return `400 Bad Request`.
      - Delete the `sender ??= 'user'` line at `routes/rooms.ts:157`. The operator short-circuit replaces it.
    - `GET /rooms/:id/messages` (line 178): the membership check at `routes/rooms.ts:193-198` must be adapted. If `X-Agent-Name` is present, resolve the agent and check `isAgentMember`; on miss, return 403. If absent, treat as operator — skip the check. The query at `chatQ.getHistory` is unchanged (it returns the join-computed `sender` field).
    - `GET /rooms` (list rooms handler): the `?member=<name>` query parameter keeps its HTTP shape. The handler passes `{ member: request.query.member, projectId: request.projectId }` to `listRooms`. The project scoping means an agent in project A asking for rooms where `member=agent-1` only sees rooms in project A — correct behavior.
    - `POST /rooms/:id/members` and `DELETE /rooms/:id/members/:member` (room membership management) — these are used by the team launcher and direct-room creation. The `member` parameter semantic is now "agent name to be resolved in this request's project context". The handlers look up the agent by `(projectId, name)` and pass the UUID to `addMember` / `removeMember`. Return `404` if the agent doesn't exist in the project.
    - `GET /rooms/:id/presence`: unchanged HTTP shape. Under the hood, `getPresence` now joins `agents` by UUID and may filter out deleted agents.
    - `GET /rooms/:id/transcript` (the raw SQL transcript query at `routes/rooms.ts:222-241`): update the SQL to join `chat_messages` with `agents` on `author_agent_id` and compute `sender` via the same COALESCE pattern as `getHistory`. The Row type stays the same.

17. Edit `server/src/routes/agents.ts` at line 74 — the direct-room creation for a newly-registered agent currently calls `addMember(db, roomId, name)` for the agent and `addMember(db, roomId, 'user')` for the operator. Under Option D:
    - The agent-side call becomes `addMember(db, roomId, newAgent.id)` (the UUID just returned from `register()`).
    - The operator-side call is **deleted outright**. The operator is not a room member; their access to the room is implicit via the route layer's operator short-circuit in step 16.

18. Edit `server/src/queries/teams.ts` at line 64 — the team room creation currently inserts `{ roomId: opts.id, member: 'user' }`. Under Option D, this entire `addMember('user')` call is **deleted**. Team creation still adds the participating agents (via the team_members flow), but the operator is not a member. The team launcher's `sendMessage` call at line 203 (using `sender: 'user'`) is separately updated in step 19.

19. Edit `server/src/team-launcher.ts` at lines 200–210. The current code does `chatQ.sendMessage(tx, { roomId, sender: 'user', content, replyTo })`. Update to the new `SendMessageOpts` shape: `chatQ.sendMessage(tx, { roomId, authorType: 'operator', authorAgentId: null, content, replyTo })`. Functionally identical, typed correctly.

20. Edit `server/src/routes/agents.ts`:
   - Every `agentsQ.*(db, name)` call becomes `agentsQ.*(db, request.projectId, name)`.
   - `POST /agents/register` (line 44) must generate and insert a UUID v7 `id` for new agents. Drizzle does not auto-populate `id` because it has no default. Either generate it in `register()` in `queries/agents.ts` (chosen — already specified in step 9), or explicitly pass it from the route. Keep the generation in `queries/agents.ts` for single-source-of-truth.
   - `DELETE /agents/:name` (lines 120–146): rescope by `request.projectId`; call `softDelete` (which now sets `'deleted'`) instead of `hardDelete`; pass `request.projectId` to `releaseByClaimantAgentId` and `releaseByAgent` (which now take `agentId` — look up the agent first to get its UUID). Also accept an optional `sessionToken` query parameter; if provided and it does not match `agent.sessionToken`, return `409 Conflict` with body `{ error: 'session token mismatch — another container has taken over this agent slot' }`. If the `sessionToken` query parameter is absent, skip the check (preserves operator and dashboard compatibility).
   - Remove the "first call vs second call" two-phase delete logic at lines 130–146. Under soft-delete semantics, the flow is simpler: flip status to `'deleted'`, release transient claims, return `{ ok: true, deleted: true }`. There is no "hard delete on second call" — the row lives until vacuum.
   - `DELETE /agents` (bulk, lines 148–158): replace with a soft-delete bulk op scoped to `request.projectId`. Call the new `deleteAllForProject` and the project-scoped `releaseAllActive`.
   - `POST /agents/:name/sync` (line 161): pass `request.projectId` to `getWorktreeInfo`.
   - `POST /agents/:name/status` (line 102): pass `request.projectId` to `updateStatus`. Validate the incoming status against the allowed set (`idle`, `working`, `done`, `error`, `paused`, `stopping` — not `deleted`, to prevent clients from soft-deleting via the status endpoint). Return `400 Bad Request` on unknown or forbidden values.
   - Remember the direct-room agent-member insert at line 74: it is rewritten in step 17.

21. Grep for every remaining caller of a renamed function or removed function. Targets: `agentsQ.getProjectId`, `agentsQ.hardDelete`, `agentsQ.deleteAll`, `agentsQ.releaseByAgent` (the parameter change), all `agent` columns renamed to `agentId`, `chatQ.sendMessage` sender → authorType/authorAgentId, `chatQ.isMember` → `isAgentMember`, `roomsQ.addMember` / `removeMember` now take agent UUIDs. Files previously identified: `server/src/git-utils.ts` (uses `getActiveNames`), `server/src/routes/build.ts` (uses `getProjectId` and `getWorktreeInfo`), `server/src/routes/tasks-claim.ts` (uses `getWorktreeInfo` and `getProjectId`), `server/src/routes/teams.ts` and `server/src/queries/teams.ts` (team_members schema change plus removed operator room-member). Update each to:
   - Pass `request.projectId` from the Fastify request.
   - Replace any `getProjectId` call with the existing `request.projectId`.
   - Convert agent-name string references to agent UUID references by adding a `getByName → .id` lookup at the call site.

22. Edit `container/lib/registration.sh`:
   - The existing `SESSION_TOKEN` export from `_register_agent` (line 164) is already present. Keep it.
   - In `_shutdown` (line 102): when calling `DELETE /agents/${AGENT_NAME}`, append `?sessionToken=${SESSION_TOKEN}` to the URL. Use a simple regex check (`[[ "$SESSION_TOKEN" =~ ^[0-9a-f]{32}$ ]]`) — the server generates tokens as 32 hex chars via `randomBytes(16).toString('hex')` in `server/src/routes/agents.ts:50`, so no URL encoding is needed, and rejecting malformed values prevents injection.
   - The existing `_post_status "error"` and similar calls do not need changes. The POST /agents/:name/status endpoint will now reject the value `'deleted'` from clients (step 20); no container code currently sends that value.
   - `container/mcp-servers/chat-channel.mjs` — **no changes required**. The MCP server's HTTP contract with the coordination server is preserved by the server-side query rewrites in steps 14–16. Specifically: `GET /rooms?member=<name>` still works (handler resolves name → id internally), `GET /rooms/{id}/messages?since=<id>` still returns rows with a `sender` field (computed via COALESCE join), and `POST /rooms/{id}/messages` still accepts the same body shape. Verified on 2026-04-08 by tracing the protocol end-to-end: agent room discovery, unread polling cursor, check_messages read, reply write, and check_presence all survive Option D unchanged from the container's perspective.

23. Update `server/src/queries/agents.test.ts` and `server/src/routes/agents.test.ts`:
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

24. Update `server/src/queries/tasks-lifecycle.test.ts`, `server/src/queries/files.test.ts`, `server/src/queries/ubt.test.ts`, `server/src/queries/coalesce.test.ts`, and any other query test files. Each gains explicit `projectId` arguments and agent-by-UUID references. Tests that were relying on text agent names in claim/release round-trips need the UUID inserted after the `register()` call.

25. Update `server/src/routes/tasks.test.ts`, `server/src/routes/build.test.ts`, `server/src/routes/ubt.test.ts`, `server/src/routes/coalesce.test.ts`, and add tests for the new chat/rooms behavior under Option D: `server/src/routes/rooms.test.ts` needs new cases covering (a) agent POSTs a message and is member — succeeds with `authorType = 'agent'`; (b) agent POSTs and is not member — 403; (c) request with no `X-Agent-Name` POSTs a message — succeeds as `authorType = 'operator'`, membership check skipped; (d) `check_messages`-equivalent GET for an agent caller checks membership; (e) `check_messages`-equivalent GET with no header skips the check. Register agents properly to get UUIDs, use them as needed.

26. Run `cd server && npm run typecheck`. Fix type errors until clean. Expect a large error fan-out; the removal of `getProjectId` and `hardDelete` will surface at every call site, the column renames will surface in every query, and the `SendMessageOpts` shape change will surface at every `chatQ.sendMessage` caller. Do not move on until typecheck is green.

27. Run `cd server && npm test`. Fix test failures until clean. Do not move on until all tests pass.

28. Validate container shell syntax: `bash -n container/lib/registration.sh`. Fix any shell errors.

29. Update `CLAUDE.md` in the repo root:
    - In the "Server Code Conventions" section, add: agent identity is `agents.id` (UUID v7); `(project_id, name)` is a unique human-readable slot, not an identity. Every agent query must take an explicit `projectId`. Agents are soft-deleted via `status = 'deleted'`; hard deletion is a vacuum-class operation not performed in normal flow.
    - Under the `/agents/*` route listing, update the DELETE route description to reflect soft-delete semantics and the optional `sessionToken` query parameter.
    - Under the coordination server summary, add a note that FK constraints now enforce cross-table integrity and that `project_id` is a foreign key to `projects.id` on every data table.
    - Under the chat/rooms section (if present), add: `room_members` is agent-only; the operator authors messages without being a member; `chat_messages` carries an `author_type` discriminator (`agent` / `operator` / `system`).

30. Delete `plans/project-id-foreign-keys.md` — it is fully absorbed into this plan. Add a note to `plans/schema-hardening-v25.md`'s "Context" section that this happened, so the decision is recoverable from the plan alone.

31. Delete the scratch audit file `plans/schema-hardening-v25-audit.md` created in step 2. Its content informed steps 9–21 and is no longer needed.

32. Final commit. Stage all the touched files, commit with a message referencing this plan by filename.

33. Operator-run rebuild and smoke test (required — the orchestrator cannot rebuild Docker from inside a container):
    - `cd container && docker compose build` on the agent image.
    - Bring down any existing containers with `./stop.sh`.
    - **Snapshot the local PGlite data directory before migrating** — this is the rollback path if anything goes wrong. `cp -r <pglite-data-dir> <pglite-data-dir>.backup-pre-schema-hardening`. Do not skip this.
    - Restart the coordination server: `cd server && npm run dev`. The migration runs at startup. Watch the console output for the three migration files (`0002_add_columns.sql`, `0003_backfill_and_orphans.sql`, `0004_constraints_and_swap.sql`) and confirm each applies cleanly. If any fails, stop, restore the backup directory, investigate, and fix.
    - Query the DB post-migration: assert `agents.id` is populated for every row, `tasks.claimed_by` column no longer exists, `tasks.claimed_by_agent_id` column exists and is a valid FK, `messages.agent` column still exists (historical audit) alongside `messages.agent_id`, `room_members.member` column no longer exists, `chat_messages.sender` column no longer exists, `chat_messages.author_type` and `chat_messages.author_agent_id` columns exist. Check the row counts pre- and post-migration for every table — live-state tables may have shrunk due to orphan cleanup (which is expected and logged), historical tables should be identical in row count.
    - Chat protocol smoke test: `./launch.sh` an agent, create a direct room via its registration flow, POST a message from the agent via the MCP `reply` tool, GET the room's messages from the dashboard, and assert the agent's message shows with the correct `sender` field (agent name) and the operator can POST a reply message that appears with `sender: 'user'`. Use the agent's `check_messages` tool from the container to read the room and assert the operator's message is visible.
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
- `agents.id` is a UUID v7 stored in the native `uuid` column type, and is the sole primary key of the agents table.
- A unique constraint on `(project_id, name)` is enforced in the schema, including for soft-deleted rows.
- Every cross-table reference to an agent is a FK on `agents.id` with `ON DELETE RESTRICT`.
- Every data table's `project_id` is a FK on `projects.id` with `ON DELETE RESTRICT`.
- `agents.status` may take the value `'deleted'`. `DELETE /agents/:name` sets this value rather than removing the row.
- `DELETE /agents/:name` rejects mismatched `sessionToken` values with `409`.
- `DELETE /agents` (bulk) is scoped to the caller's `projectId` and is soft-delete.
- All tests in `server/src` pass.
- The regression tests added in step 23 pass.
- The chat-protocol tests added in step 25 pass.
- The operator smoke test in step 33 reproduces cross-project isolation, agent reactivation, and the chat protocol end-to-end (agent-authored and operator-authored messages round-trip through the room).
- `server/src/queries/agents.ts` exports no `getProjectId`, `hardDelete`, or `deleteAll`.
- `server/src/queries/rooms.ts` has no `'user'` string sentinels; `addMember` takes an agent UUID, not a string.
- `server/src/queries/chat.ts` has no `sender` parameter on `sendMessage`; it takes `authorType` and `authorAgentId` instead.
- `server/src/routes/rooms.ts` POST `/rooms/:id/messages` distinguishes operator and agent callers by the presence of `X-Agent-Name`; the operator path skips the membership check and writes `author_type = 'operator'`.
- `room_members.member` column does not exist. `chat_messages.sender` column does not exist. Both are replaced by typed columns with FKs and CHECK constraints.
- `plans/project-id-foreign-keys.md` is deleted; its intent is documented in this plan.
- `CLAUDE.md` reflects the new invariants.
- **Container code is unchanged for chat protocol.** `container/mcp-servers/chat-channel.mjs` is not touched; the agent's view of the chat HTTP contract is preserved end-to-end (room discovery, polling, check_messages, reply, check_presence). Verified on 2026-04-08 via end-to-end trace.
- **Data preservation:** no table is wiped. Live-state tables (`tasks`, `files`, `ubt_lock`, `ubt_queue`, `team_members`) may have orphaned rows removed per the orphan policy. `room_members` loses all operator rows (intentional — dead write-only data) and any agent rows that failed to resolve to a valid `agents.id`. Historical tables (`messages`, `build_history`) retain all rows with `agent_id` populated where resolvable and NULL where orphaned. `chat_messages` retains all rows; orphaned authorship is classified as `'system'`. Audit trail is preserved where data integrity permits.
- **Migration file is re-runnable against any Postgres backend:** the three migration files apply identically on PGlite and on a future Supabase deployment. No destructive `DELETE FROM` of non-orphaned data; no environment-specific branches.

## Explicitly out of scope for this plan

- `agent_type` observability column on `agents`. Follow-up: simple ALTER TABLE.
- Vacuum / compaction tooling for truly removing soft-deleted agents and their historical references. Follow-up: a small CLI tool that takes a retention policy and a date cutoff, archives, and hard-deletes with cascades in a transaction.
- Dashboard UI changes to surface the `deleted` status. Follow-up: small UI update to show deleted agents in a "History" section.
- A dedicated `operators` table (Option B from the design evaluation). The current local-single-operator model does not justify it. If/when the scaffold becomes multi-operator, the migration is straightforward: create `operators(id, name)`, add `author_operator_id uuid REFERENCES operators(id)` to `chat_messages`, extend the CHECK constraint.
- A full `participants` table unification (Option C from the design evaluation). Much larger refactor with no current motivating benefit.
- Any reconsideration of `messages.agent` if it turns out to be a free-form label rather than an agent reference — that decision is made in step 5 based on field semantics discovered during the audit in step 2.
