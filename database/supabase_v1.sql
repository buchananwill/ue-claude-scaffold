-- Supabase schema for Claude Scaffold coordination server
-- This is the complete schema needed to mirror the SQLite db.ts

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- Agent Management
-- ============================================================================

CREATE TABLE IF NOT EXISTS agents (
                                      name TEXT PRIMARY KEY,
                                      worktree TEXT NOT NULL,
                                      plan_doc TEXT,
                                      status TEXT NOT NULL DEFAULT 'idle',
                                      mode TEXT NOT NULL DEFAULT 'single',
                                      registered_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                                      container_host TEXT,
                                      session_token TEXT UNIQUE,
                                      metadata JSONB,
                                      last_heartbeat TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agents_session_token ON agents(session_token);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_last_heartbeat ON agents(last_heartbeat);

-- ============================================================================
-- UBT Lock & Queue
-- ============================================================================

CREATE TABLE IF NOT EXISTS ubt_lock (
                                        id INTEGER PRIMARY KEY DEFAULT 1,
                                        holder TEXT,
                                        acquired_at TIMESTAMP WITH TIME ZONE,
                                        priority INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ubt_queue (
                                         id BIGSERIAL PRIMARY KEY,
                                         agent TEXT NOT NULL,
                                         priority INTEGER DEFAULT 0,
                                         requested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ubt_queue_priority ON ubt_queue(priority DESC, id ASC);

-- ============================================================================
-- Build History
-- ============================================================================

CREATE TABLE IF NOT EXISTS build_history (
                                             id BIGSERIAL PRIMARY KEY,
                                             agent TEXT NOT NULL,
                                             type TEXT NOT NULL CHECK (type IN ('build', 'test')),
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                             duration_ms INTEGER,
                             success BOOLEAN,
                             output TEXT,
                             stderr TEXT
                             );

CREATE INDEX IF NOT EXISTS idx_build_history_agent ON build_history(agent);
CREATE INDEX IF NOT EXISTS idx_build_history_started_at ON build_history(started_at DESC);

-- ============================================================================
-- Message Board
-- ============================================================================

CREATE TABLE IF NOT EXISTS messages (
                                        id BIGSERIAL PRIMARY KEY,
                                        from_agent TEXT NOT NULL,
                                        channel TEXT NOT NULL,
                                        type TEXT NOT NULL,
                                        payload TEXT NOT NULL,
                                        claimed_by TEXT,
                                        claimed_at TIMESTAMP WITH TIME ZONE,
                                        resolved_at TIMESTAMP WITH TIME ZONE,
                                        result TEXT,
                                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel, id);
CREATE INDEX IF NOT EXISTS idx_messages_claimed ON messages(claimed_by);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);

-- ============================================================================
-- Task Queue
-- ============================================================================

CREATE TABLE IF NOT EXISTS tasks (
                                     id BIGSERIAL PRIMARY KEY,
                                     title TEXT NOT NULL,
                                     description TEXT DEFAULT '',
                                     source_path TEXT,
                                     acceptance_criteria TEXT,
                                     status TEXT NOT NULL DEFAULT 'pending'
                                     CHECK (status IN ('pending','claimed','in_progress','completed','failed','integrated','cycle')),
    priority INTEGER NOT NULL DEFAULT 0,
    base_priority INTEGER NOT NULL DEFAULT 0,
    claimed_by TEXT,
    claimed_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    result TEXT,
    progress_log TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                             );

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority DESC, id ASC);
CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by ON tasks(claimed_by);

-- ============================================================================
-- File Registry
-- ============================================================================

CREATE TABLE IF NOT EXISTS files (
                                     path TEXT PRIMARY KEY,
                                     claimant TEXT,
                                     claimed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_files_claimant ON files(claimant);

-- ============================================================================
-- Task-File Relationship
-- ============================================================================

CREATE TABLE IF NOT EXISTS task_files (
                                          task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL REFERENCES files(path),
    PRIMARY KEY (task_id, file_path)
    );

CREATE INDEX IF NOT EXISTS idx_task_files_path ON task_files(file_path);

-- ============================================================================
-- Task Dependencies
-- ============================================================================

CREATE TABLE IF NOT EXISTS task_dependencies (
                                                 task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on),
    CHECK (task_id != depends_on)
    );

CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_deps_dep ON task_dependencies(depends_on);

-- ============================================================================
-- Rooms & Chat
-- ============================================================================

CREATE TABLE IF NOT EXISTS rooms (
                                     id TEXT PRIMARY KEY,
                                     name TEXT NOT NULL,
                                     type TEXT NOT NULL CHECK (type IN ('group','direct')),
    created_by TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                             );

CREATE TABLE IF NOT EXISTS room_members (
                                            room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                                                                                           PRIMARY KEY (room_id, member)
    );

CREATE INDEX IF NOT EXISTS idx_room_members_member ON room_members(member);

CREATE TABLE IF NOT EXISTS chat_messages (
                                             id BIGSERIAL PRIMARY KEY,
                                             room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    sender TEXT NOT NULL,
    content TEXT NOT NULL,
    reply_to BIGINT REFERENCES chat_messages(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                                                                                            );

CREATE INDEX IF NOT EXISTS idx_chat_room_id ON chat_messages(room_id, id);
CREATE INDEX IF NOT EXISTS idx_chat_created_at ON chat_messages(created_at DESC);

-- ============================================================================
-- Teams
-- ============================================================================

CREATE TABLE IF NOT EXISTS teams (
                                     id TEXT PRIMARY KEY,
                                     name TEXT NOT NULL,
                                     brief_path TEXT,
                                     status TEXT NOT NULL DEFAULT 'active'
                                     CHECK (status IN ('active','converging','dissolved')),
    deliverable TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    dissolved_at TIMESTAMP WITH TIME ZONE
                               );

CREATE TABLE IF NOT EXISTS team_members (
                                            team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    agent_name TEXT NOT NULL,
    role TEXT NOT NULL,
    is_leader BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (team_id, agent_name)
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_team_leader ON team_members(team_id) WHERE is_leader = TRUE;

-- ============================================================================
-- Fastify Host Management (for coordination server clusters)
-- ============================================================================

CREATE TABLE IF NOT EXISTS fastify_hosts (
                                             id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_name TEXT UNIQUE NOT NULL,
    url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_heartbeat TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                                 );

CREATE INDEX IF NOT EXISTS idx_fastify_hosts_status ON fastify_hosts(status);
CREATE INDEX IF NOT EXISTS idx_fastify_hosts_last_heartbeat ON fastify_hosts(last_heartbeat);

-- ============================================================================
-- Staging Worktrees
-- ============================================================================

CREATE TABLE IF NOT EXISTS staging_worktrees (
                                                 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worktree_name TEXT UNIQUE NOT NULL,
    fastify_host_id UUID NOT NULL REFERENCES fastify_hosts(id) ON DELETE CASCADE,
    branch_path TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_sync TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                                                                   );

CREATE INDEX IF NOT EXISTS idx_staging_worktrees_host ON staging_worktrees(fastify_host_id);
CREATE INDEX IF NOT EXISTS idx_staging_worktrees_status ON staging_worktrees(status);
CREATE INDEX IF NOT EXISTS idx_staging_worktrees_last_sync ON staging_worktrees(last_sync);

-- ============================================================================
-- Container Assignments
-- ============================================================================

CREATE TABLE IF NOT EXISTS container_assignments (
                                                     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_name TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
    worktree_id UUID NOT NULL REFERENCES staging_worktrees(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    released_at TIMESTAMP WITH TIME ZONE,
                                                         UNIQUE(agent_name, worktree_id)
    );

CREATE INDEX IF NOT EXISTS idx_container_assignments_agent ON container_assignments(agent_name);
CREATE INDEX IF NOT EXISTS idx_container_assignments_worktree ON container_assignments(worktree_id);

-- ============================================================================
-- Admin Commands Queue
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin_commands (
                                              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id UUID REFERENCES fastify_hosts(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    args JSONB,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
    output TEXT,
    stderr TEXT,
    exit_code INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
                                                  );

CREATE INDEX IF NOT EXISTS idx_admin_commands_status ON admin_commands(status);
CREATE INDEX IF NOT EXISTS idx_admin_commands_host_id ON admin_commands(host_id);
CREATE INDEX IF NOT EXISTS idx_admin_commands_created_at ON admin_commands(created_at DESC);

-- ============================================================================
-- RPC Functions (for atomic operations)
-- ============================================================================

-- Register an agent with its room in one transaction
CREATE OR REPLACE FUNCTION register_agent_with_room(
  p_name TEXT,
  p_status TEXT,
  p_metadata JSONB,
  p_session_token TEXT
) RETURNS TABLE (agent_id TEXT, room_id TEXT, session_token TEXT) AS $$
DECLARE
v_room_id TEXT;
BEGIN
  -- Insert or update agent
INSERT INTO agents (name, status, metadata, session_token)
VALUES (p_name, p_status, p_metadata, p_session_token)
    ON CONFLICT (session_token) DO NOTHING;

-- Create a private room for the agent if it doesn't exist
v_room_id := 'room_' || p_name || '_private';
INSERT INTO rooms (id, name, type, created_by)
VALUES (v_room_id, p_name || ' Private Room', 'direct', p_name)
    ON CONFLICT (id) DO NOTHING;

-- Add agent to their own room
INSERT INTO room_members (room_id, member)
VALUES (v_room_id, p_name)
    ON CONFLICT (room_id, member) DO NOTHING;

RETURN QUERY SELECT p_name, v_room_id, p_session_token;
END;
$$ LANGUAGE plpgsql;

-- Acquire UBT lock with priority queue
CREATE OR REPLACE FUNCTION acquire_ubt_lock(
  p_agent TEXT,
  p_priority INTEGER DEFAULT 0
) RETURNS TABLE (granted BOOLEAN, "position" INTEGER, holder TEXT) AS $$
DECLARE
v_current_holder TEXT;
  v_position INTEGER;
BEGIN
  -- Check current lock holder
SELECT holder INTO v_current_holder FROM ubt_lock WHERE id = 1;

IF v_current_holder IS NULL OR v_current_holder = '' THEN
    -- Lock is free, grant it
UPDATE ubt_lock SET holder = p_agent, acquired_at = CURRENT_TIMESTAMP, priority = p_priority
WHERE id = 1;
RETURN QUERY SELECT TRUE, 0, p_agent;
ELSE
    -- Lock is held, queue the request
    INSERT INTO ubt_queue (agent, priority) VALUES (p_agent, p_priority);
SELECT COUNT(*)::INTEGER INTO v_position FROM ubt_queue WHERE priority > p_priority OR (priority = p_priority AND agent = p_agent);
RETURN QUERY SELECT FALSE, v_position, v_current_holder;
END IF;
END;
$$ LANGUAGE plpgsql;

-- Release UBT lock and grant to next in queue
CREATE OR REPLACE FUNCTION release_ubt_lock(p_agent TEXT) RETURNS TABLE (next_agent TEXT) AS $$
DECLARE
v_next_agent TEXT;
BEGIN
  -- Only release if held by the specified agent
  IF (SELECT holder FROM ubt_lock WHERE id = 1) = p_agent THEN
-- Get next from queue
SELECT agent INTO v_next_agent FROM ubt_queue ORDER BY priority DESC, id ASC LIMIT 1;

IF v_next_agent IS NOT NULL THEN
      -- Grant to next
UPDATE ubt_lock SET holder = v_next_agent, acquired_at = CURRENT_TIMESTAMP WHERE id = 1;
DELETE FROM ubt_queue WHERE id IN (SELECT id FROM ubt_queue WHERE agent = v_next_agent ORDER BY id ASC LIMIT 1);
ELSE
      -- Queue empty, release lock
UPDATE ubt_lock SET holder = NULL, acquired_at = NULL WHERE id = 1;
END IF;
END IF;

RETURN QUERY SELECT v_next_agent;
END;
$$ LANGUAGE plpgsql;

-- Sweep stale locks (older than timeout_ms)
CREATE OR REPLACE FUNCTION sweep_stale_locks(timeout_ms INTEGER DEFAULT 600000) RETURNS TABLE (released BOOLEAN) AS $$
DECLARE
v_acquired_at TIMESTAMP WITH TIME ZONE;
BEGIN
SELECT acquired_at INTO v_acquired_at FROM ubt_lock WHERE id = 1;

IF v_acquired_at IS NOT NULL AND (CURRENT_TIMESTAMP - v_acquired_at) > INTERVAL '1 millisecond' * timeout_ms THEN
UPDATE ubt_lock SET holder = NULL, acquired_at = NULL WHERE id = 1;
RETURN QUERY SELECT TRUE;
ELSE
    RETURN QUERY SELECT FALSE;
END IF;
END;
$$ LANGUAGE plpgsql;

-- Claim next task for an agent
CREATE OR REPLACE FUNCTION claim_next_task(p_agent TEXT) RETURNS TABLE (task_id BIGINT) AS $$
DECLARE
v_task_id BIGINT;
BEGIN
  -- Find next unclaimed pending task
SELECT id INTO v_task_id FROM tasks
WHERE status = 'pending'
ORDER BY priority DESC, id ASC
    LIMIT 1
  FOR UPDATE SKIP LOCKED;

IF v_task_id IS NOT NULL THEN
UPDATE tasks
SET status = 'claimed', claimed_by = p_agent, claimed_at = CURRENT_TIMESTAMP
WHERE id = v_task_id;
RETURN QUERY SELECT v_task_id;
ELSE
    RETURN QUERY SELECT NULL::BIGINT;
END IF;
END;
$$ LANGUAGE plpgsql;

-- Create task with files and dependencies
CREATE OR REPLACE FUNCTION create_task_with_files(
  p_title TEXT,
  p_description TEXT,
  p_source_path TEXT,
  p_acceptance_criteria TEXT,
  p_priority INTEGER,
  p_base_priority INTEGER,
  p_files JSONB,
  p_depends_on JSONB
) RETURNS TABLE (task_id BIGINT) AS $$
DECLARE
v_task_id BIGINT;
  v_file_path TEXT;
  v_dep_id BIGINT;
BEGIN
  -- Insert task
INSERT INTO tasks (title, description, source_path, acceptance_criteria, priority, base_priority)
VALUES (p_title, p_description, p_source_path, p_acceptance_criteria, p_priority, p_base_priority)
    RETURNING id INTO v_task_id;

-- Insert files
IF p_files IS NOT NULL THEN
    FOR v_file_path IN SELECT jsonb_array_elements_text(p_files)
                                     LOOP
                              INSERT INTO files (path, claimant, claimed_at) VALUES (v_file_path, NULL, NULL) ON CONFLICT (path) DO NOTHING;
INSERT INTO task_files (task_id, file_path) VALUES (v_task_id, v_file_path) ON CONFLICT (task_id, file_path) DO NOTHING;
END LOOP;
END IF;

  -- Insert dependencies
  IF p_depends_on IS NOT NULL THEN
    FOR v_dep_id IN SELECT (jsonb_array_elements_text(p_depends_on))::BIGINT
    LOOP
                             INSERT INTO task_dependencies (task_id, depends_on) VALUES (v_task_id, v_dep_id) ON CONFLICT (task_id, depends_on) DO NOTHING;
END LOOP;
END IF;

RETURN QUERY SELECT v_task_id;
END;
$$ LANGUAGE plpgsql;

-- Coalesce system release (pause agents, wait for tasks, release files)
CREATE OR REPLACE FUNCTION coalesce_release() RETURNS TABLE (freed INT) AS $$
DECLARE
v_freed INT;
BEGIN
  -- Count how many files will be freed
SELECT COUNT(*)::INT INTO v_freed FROM files WHERE claimant IS NOT NULL;

-- Release all file claims
UPDATE files SET claimant = NULL, claimed_at = NULL WHERE claimant IS NOT NULL;

RETURN QUERY SELECT v_freed;
END;
$$ LANGUAGE plpgsql;

-- Full-text search across tasks, messages, agents
CREATE OR REPLACE FUNCTION search_scaffolding(
  p_query TEXT,
  p_limit INTEGER DEFAULT 100
) RETURNS TABLE (
  result_type TEXT,
  result_id TEXT,
  title TEXT,
  content TEXT,
  created_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
RETURN QUERY
       (SELECT 'task'::TEXT, id::TEXT, title, description, created_at
            FROM tasks
     WHERE to_tsvector('english', title || ' ' || COALESCE(description, '')) @@ plainto_tsquery('english', p_query)
     LIMIT p_limit)
    UNION ALL
    (SELECT 'message'::TEXT, id::TEXT, type, payload, created_at
     FROM messages
     WHERE to_tsvector('english', type || ' ' || payload) @@ plainto_tsquery('english', p_query)
     LIMIT p_limit)
  UNION ALL
    (SELECT 'agent'::TEXT, name, name, COALESCE(status, ''), registered_at
     FROM agents
     WHERE to_tsvector('english', name || ' ' || COALESCE(status, '')) @@ plainto_tsquery('english', p_query)
     LIMIT p_limit);
END;
$$ LANGUAGE plpgsql;
