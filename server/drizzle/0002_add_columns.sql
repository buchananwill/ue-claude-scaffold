-- Add agents.id as nullable uuid, populate for existing rows
ALTER TABLE agents ADD COLUMN id uuid;
UPDATE agents SET id = gen_random_uuid() WHERE id IS NULL;
-- Cannot add PK or NOT NULL yet — must resolve duplicate (project_id, name) first in file 0003
--> statement-breakpoint
-- Add new FK columns on every referring table, all nullable for now
ALTER TABLE tasks ADD COLUMN claimed_by_agent_id uuid;
ALTER TABLE files ADD COLUMN claimant_agent_id uuid;
ALTER TABLE build_history ADD COLUMN agent_id uuid;
ALTER TABLE ubt_lock ADD COLUMN holder_agent_id uuid;
ALTER TABLE ubt_lock ADD COLUMN host_id text DEFAULT 'local';
ALTER TABLE ubt_queue ADD COLUMN agent_id uuid;
ALTER TABLE messages ADD COLUMN agent_id uuid;
ALTER TABLE team_members ADD COLUMN agent_id uuid;
--> statement-breakpoint
-- room_members: add surrogate id and agent_id. The old `member` text column
-- stays for now; it will be dropped in 0004 after orphan cleanup in 0003.
ALTER TABLE room_members ADD COLUMN id uuid;
UPDATE room_members SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE room_members ADD COLUMN agent_id uuid;
--> statement-breakpoint
-- chat_messages: add author_type discriminator and author_agent_id FK column.
-- The old `sender` text column stays for now; it will be dropped in 0004.
ALTER TABLE chat_messages ADD COLUMN author_type text;
ALTER TABLE chat_messages ADD COLUMN author_agent_id uuid;
