# Phase 3: Migration SQL files

Hand-write three migration files that stage the schema rewrite safely. File 0002 is additive only, 0003 backfills and handles orphans, 0004 adds constraints and drops old columns. Each file runs in an implicit transaction; a failure in any file rolls the DB back to the state before that file ran.

The `drizzle-kit generate` output is a draft reference, not the final artifact — discard its body and replace it with the hand-written SQL below. PGlite features verified on 2026-04-08 via probe: `gen_random_uuid()` (v4, acceptable for backfill — new agents post-migration use JS-generated v7 per Phase 5), `UPDATE ... FROM` join semantics (orphans correctly stay NULL), partial unique indexes with enforcement, CHECK constraints with OR expressions.

## Files

- `server/drizzle/0002_add_columns.sql` (new)
- `server/drizzle/0003_backfill_and_orphans.sql` (new)
- `server/drizzle/0004_constraints_and_swap.sql` (new)
- `server/drizzle/meta/_journal.json` (modify — `drizzle-kit generate` updates this)

## Work

1. Generate a draft with `cd server && npx drizzle-kit generate`. Inspect the output in `server/drizzle/0002_*.sql`. Note the file name drizzle-kit picked. The draft is informational only — next steps replace its body with hand-written SQL and rename the file to `0002_add_columns.sql` (and create 0003, 0004 alongside). The journal entry must point at the three new files in order. Match the idiom used in `server/drizzle/0000_past_luke_cage.sql` and `server/drizzle/0001_worried_marvex.sql` for statement terminators and file-level comments.
2. Write `server/drizzle/0002_add_columns.sql` — additive only, no drops, no constraints. Goal: create the new columns alongside the old ones without breaking anything the pre-migration server code depends on.
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
   ALTER TABLE ubt_lock ADD COLUMN host_id text DEFAULT 'local';
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
   ```
3. Write `server/drizzle/0003_backfill_and_orphans.sql` — backfill the new columns from the old text references, handle orphans per policy, resolve duplicate `(project_id, name)` in agents.
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

   -- STEP 2: Backfill tasks.claimed_by_agent_id from agents(project_id, name).
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

   -- STEP 4: UBT lock is host-level, not project-scoped. Clear the lock table —
   -- lock state is transient and will be lazily re-created on the next build request.
   -- This also eliminates any per-project rows left over from the old schema.
   DELETE FROM ubt_lock;

   -- STEP 5: Backfill ubt_queue.agent_id. Host-level queue — match by name only,
   -- no project scoping. Live-state orphan policy: DELETE unresolvable rows.
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

   -- STEP 7: Backfill room_members.agent_id. Under Option D, room_members becomes
   -- agent-only. Operator rows (member = 'user') are dead write-only data — the
   -- dashboard does not read them and no server query joins on them. Policy:
   -- DELETE all operator rows outright, DELETE agent rows that failed to resolve.
   UPDATE room_members SET agent_id = a.id
   FROM agents a, rooms r
   WHERE room_members.member = a.name
     AND room_members.room_id = r.id
     AND r.project_id = a.project_id
     AND room_members.member != 'user';

   DELETE FROM room_members WHERE member = 'user';
   DELETE FROM room_members WHERE agent_id IS NULL;

   -- STEP 8: Backfill chat_messages.author_type and author_agent_id from the
   -- old `sender` column. Agents resolved by name; 'user' becomes operator;
   -- unknown senders become system.
   UPDATE chat_messages cm SET
     author_type = 'agent',
     author_agent_id = a.id
   FROM agents a, rooms r
   WHERE cm.sender = a.name
     AND cm.room_id = r.id
     AND r.project_id = a.project_id
     AND cm.sender != 'user';

   UPDATE chat_messages SET author_type = 'operator'
   WHERE sender = 'user' AND author_type IS NULL;

   -- Historical orphan policy for chat_messages: any row whose old `sender`
   -- referenced a since-deleted agent is classified as 'system'. The original
   -- sender name is lost, which is acceptable for a handful of pre-migration
   -- orphan rows in a local dev DB.
   UPDATE chat_messages SET author_type = 'system'
   WHERE author_type IS NULL;

   -- STEP 9: Backfill messages.agent_id. Historical orphan policy: KEEP the row,
   -- leave agent_id NULL. The existing messages.agent text column is retained
   -- as a display-only legacy field. (Applies only if messages.agent is a
   -- referential column per the Phase 1 audit; otherwise skip this UPDATE.)
   UPDATE messages SET agent_id = a.id
   FROM agents a
   WHERE messages.agent = a.name AND messages.project_id = a.project_id;
   -- No orphan cleanup — NULLs are expected and retained.

   -- STEP 10: Backfill build_history.agent_id. Historical orphan policy as above.
   UPDATE build_history SET agent_id = a.id
   FROM agents a
   WHERE build_history.agent = a.name AND build_history.project_id = a.project_id;

   -- STEP 11: Clean up project_id orphans per plans/project-id-foreign-keys.md logic.
   -- Delete rows in child tables whose project_id has no matching projects.id row.
   -- Order: children before parents.
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
   -- ubt_lock and ubt_queue are host-level — NOT included in project_id orphan cleanup.

   -- agents: soft-delete rather than remove, to preserve historical references
   UPDATE agents SET status = 'deleted'
   WHERE project_id NOT IN (SELECT id FROM projects);
   ```
4. Write `server/drizzle/0004_constraints_and_swap.sql` — add every constraint, drop old columns (except historical exceptions), finalize the schema.
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
   ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_author_agent_fk
     FOREIGN KEY (author_agent_id) REFERENCES agents(id) ON DELETE RESTRICT;

   -- project_id FKs on 7 project-scoped data tables (absorbs plans/project-id-foreign-keys.md)
   -- UBT tables are host-level and do NOT get project_id FKs.
   ALTER TABLE agents ALTER COLUMN project_id DROP DEFAULT;
   ALTER TABLE agents ADD CONSTRAINT agents_project_fk
     FOREIGN KEY (project_id) REFERENCES projects(id);
   ALTER TABLE tasks ALTER COLUMN project_id DROP DEFAULT;
   ALTER TABLE tasks ADD CONSTRAINT tasks_project_fk
     FOREIGN KEY (project_id) REFERENCES projects(id);
   ALTER TABLE files ALTER COLUMN project_id DROP DEFAULT;
   ALTER TABLE files ADD CONSTRAINT files_project_fk
     FOREIGN KEY (project_id) REFERENCES projects(id);
   ALTER TABLE messages ALTER COLUMN project_id DROP DEFAULT;
   ALTER TABLE messages ADD CONSTRAINT messages_project_fk
     FOREIGN KEY (project_id) REFERENCES projects(id);
   ALTER TABLE build_history ALTER COLUMN project_id DROP DEFAULT;
   ALTER TABLE build_history ADD CONSTRAINT build_history_project_fk
     FOREIGN KEY (project_id) REFERENCES projects(id);
   ALTER TABLE rooms ALTER COLUMN project_id DROP DEFAULT;
   ALTER TABLE rooms ADD CONSTRAINT rooms_project_fk
     FOREIGN KEY (project_id) REFERENCES projects(id);
   ALTER TABLE teams ALTER COLUMN project_id DROP DEFAULT;
   ALTER TABLE teams ADD CONSTRAINT teams_project_fk
     FOREIGN KEY (project_id) REFERENCES projects(id);

   -- ubt_lock: migrate PK from project_id to host_id (host-level singleton)
   ALTER TABLE ubt_lock ALTER COLUMN host_id SET NOT NULL;
   ALTER TABLE ubt_lock DROP CONSTRAINT ubt_lock_pkey;
   ALTER TABLE ubt_lock ADD CONSTRAINT ubt_lock_pkey PRIMARY KEY (host_id);
   ALTER TABLE ubt_lock DROP COLUMN project_id;

   -- ubt_queue: remove project_id (global queue, not project-scoped)
   ALTER TABLE ubt_queue DROP COLUMN project_id;

   -- NOT NULL on FK columns whose old text column was NOT NULL
   ALTER TABLE build_history ALTER COLUMN agent_id SET NOT NULL;
   ALTER TABLE ubt_queue ALTER COLUMN agent_id SET NOT NULL;
   ALTER TABLE team_members ALTER COLUMN agent_id SET NOT NULL;
   -- ubt_lock.holder_agent_id was nullable (released lock), tasks.claimed_by_agent_id
   -- was nullable, files.claimant_agent_id was nullable, messages.agent_id kept
   -- nullable for orphan audit preservation — leave these.

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
   ALTER TABLE chat_messages ALTER COLUMN author_type SET NOT NULL;
   ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_author_type_check
     CHECK (author_type IN ('agent', 'operator', 'system'));
   ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_author_agent_check
     CHECK (
       (author_type = 'agent' AND author_agent_id IS NOT NULL)
       OR (author_type IN ('operator', 'system') AND author_agent_id IS NULL)
     );
   ALTER TABLE chat_messages DROP COLUMN sender;

   -- Drop old text columns on LIVE-STATE tables (where orphans were resolved).
   -- DO NOT drop the agent text column on messages or build_history — those stay as
   -- display-only legacy fields for historical audit trail preservation.
   ALTER TABLE tasks DROP COLUMN claimed_by;
   ALTER TABLE files DROP COLUMN claimant;
   ALTER TABLE ubt_lock DROP COLUMN holder;
   ALTER TABLE ubt_queue DROP COLUMN agent;
   ALTER TABLE team_members DROP COLUMN agent_name;
   -- messages.agent: KEEP (historical audit trail)
   -- build_history.agent: KEEP (historical audit trail)
   ```
5. Ensure `server/drizzle/meta/_journal.json` references all three new files in the correct order. If `drizzle-kit generate` produced a differently-named 0002 file, delete that file and update the journal to reference `0002_add_columns.sql`, `0003_backfill_and_orphans.sql`, `0004_constraints_and_swap.sql` in that order.
6. Commit the three migration files and journal update. Message: `Phase 3: Staged migration SQL for schema hardening V2.5 (add columns, backfill+orphans, constraints+swap)`.

## Acceptance criteria

- `server/drizzle/0002_add_columns.sql` exists with the additive-only content.
- `server/drizzle/0003_backfill_and_orphans.sql` exists with the backfill and orphan-handling content.
- `server/drizzle/0004_constraints_and_swap.sql` exists with the constraint and column-drop content.
- `server/drizzle/meta/_journal.json` references the three files in numerical order after the existing 0000 and 0001 entries.
- No migration file contains an unscoped `DELETE FROM <table>;` of non-orphaned data — except `ubt_lock`, which is intentionally cleared (transient host-level state). Other orphan deletions are gated by `WHERE project_id NOT IN (...)` or `WHERE agent_id IS NULL`.
- The SQL is syntactically valid Postgres (statement terminators, balanced parentheses, quoted identifiers where needed). Do not run the migration — that is the operator's responsibility in Phase 15, after all code phases are complete and merged.
- Commit exists with the three files and the journal.
