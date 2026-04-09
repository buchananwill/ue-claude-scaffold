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
--> statement-breakpoint
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
--> statement-breakpoint
-- STEP 3: Backfill files.claimant_agent_id. Live-state orphan policy: NULL the claim.
UPDATE files SET claimant_agent_id = a.id
FROM agents a
WHERE files.claimant = a.name AND files.project_id = a.project_id;

UPDATE files SET claimant = NULL, claimed_at = NULL
WHERE claimant IS NOT NULL AND claimant_agent_id IS NULL;
--> statement-breakpoint
-- STEP 4: UBT lock is host-level, not project-scoped. Clear the lock table —
-- lock state is transient and will be lazily re-created on the next build request.
-- This also eliminates any per-project rows left over from the old schema.
DELETE FROM ubt_lock;
--> statement-breakpoint
-- STEP 5: Backfill ubt_queue.agent_id. Host-level queue — match by name only,
-- no project scoping. Live-state orphan policy: DELETE unresolvable rows.
UPDATE ubt_queue SET agent_id = a.id
FROM agents a
WHERE ubt_queue.agent = a.name;

DELETE FROM ubt_queue WHERE agent_id IS NULL;
--> statement-breakpoint
-- STEP 6: Backfill team_members.agent_id. Membership orphan policy: DELETE the row.
UPDATE team_members SET agent_id = a.id
FROM agents a, teams t
WHERE team_members.agent_name = a.name
  AND team_members.team_id = t.id
  AND t.project_id = a.project_id;

DELETE FROM team_members WHERE agent_id IS NULL;
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
-- STEP 9: Backfill messages.agent_id. Historical orphan policy: KEEP the row,
-- leave agent_id NULL. The existing messages.agent text column is retained
-- as a display-only legacy field. (Applies only if messages.agent is a
-- referential column per the Phase 1 audit; otherwise skip this UPDATE.)
UPDATE messages SET agent_id = a.id
FROM agents a
WHERE messages.agent = a.name AND messages.project_id = a.project_id;
-- No orphan cleanup — NULLs are expected and retained.
--> statement-breakpoint
-- STEP 10: Backfill build_history.agent_id. Historical orphan policy as above.
UPDATE build_history SET agent_id = a.id
FROM agents a
WHERE build_history.agent = a.name AND build_history.project_id = a.project_id;
--> statement-breakpoint
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
