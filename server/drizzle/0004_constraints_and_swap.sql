-- agents: swap PK
ALTER TABLE agents ALTER COLUMN id SET NOT NULL;
ALTER TABLE agents DROP CONSTRAINT agents_pkey;
ALTER TABLE agents ADD CONSTRAINT agents_pkey PRIMARY KEY (id);
ALTER TABLE agents ADD CONSTRAINT agents_project_name_unique UNIQUE (project_id, name);
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
-- ubt_lock: migrate PK from project_id to host_id (host-level singleton)
ALTER TABLE ubt_lock ALTER COLUMN host_id SET NOT NULL;
ALTER TABLE ubt_lock DROP CONSTRAINT ubt_lock_pkey;
ALTER TABLE ubt_lock ADD CONSTRAINT ubt_lock_pkey PRIMARY KEY (host_id);
ALTER TABLE ubt_lock DROP COLUMN project_id;
--> statement-breakpoint
-- ubt_queue: remove project_id (global queue, not project-scoped)
ALTER TABLE ubt_queue DROP COLUMN project_id;
--> statement-breakpoint
-- NOT NULL on FK columns whose old text column was NOT NULL
ALTER TABLE build_history ALTER COLUMN agent_id SET NOT NULL;
ALTER TABLE ubt_queue ALTER COLUMN agent_id SET NOT NULL;
ALTER TABLE team_members ALTER COLUMN agent_id SET NOT NULL;
-- ubt_lock.holder_agent_id was nullable (released lock), tasks.claimed_by_agent_id
-- was nullable, files.claimant_agent_id was nullable, messages.agent_id kept
-- nullable for orphan audit preservation — leave these.
--> statement-breakpoint
-- team_members: swap PK from (team_id, agent_name) to (team_id, agent_id)
ALTER TABLE team_members DROP CONSTRAINT team_members_pkey;
ALTER TABLE team_members ADD CONSTRAINT team_members_pkey PRIMARY KEY (team_id, agent_id);
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
