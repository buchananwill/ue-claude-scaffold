import Database from 'better-sqlite3';

// The schema is embedded here as the single source of truth so it ships with
// the compiled package. If you're editing the schema and want SQL tooling
// support, copy this into a temporary .sql file for your editor, then paste
// the result back here. Don't check the .sql copy in — one source of truth.
const SCHEMA_SQL = `
-- Schema version tracking for future migrations
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
INSERT OR IGNORE INTO schema_version(version) VALUES (12);

-- Agent registration and status
CREATE TABLE IF NOT EXISTS agents (
  name        TEXT PRIMARY KEY,
  worktree    TEXT NOT NULL,
  plan_doc    TEXT,
  status      TEXT NOT NULL DEFAULT 'idle',
  mode        TEXT NOT NULL DEFAULT 'single',
  registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  container_host TEXT,
  session_token TEXT UNIQUE
);

-- UBT lock — singleton mutex
CREATE TABLE IF NOT EXISTS ubt_lock (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  holder      TEXT,
  acquired_at DATETIME,
  priority    INTEGER DEFAULT 0
);

-- UBT queue — FIFO with priority
CREATE TABLE IF NOT EXISTS ubt_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT NOT NULL,
  priority    INTEGER DEFAULT 0,
  requested_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Build/test invocation history for wait-time estimation
CREATE TABLE IF NOT EXISTS build_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent        TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('build', 'test')),
  started_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  duration_ms  INTEGER,
  success      INTEGER
);

-- Message board
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent  TEXT NOT NULL,
  channel     TEXT NOT NULL,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  claimed_by  TEXT,
  claimed_at  DATETIME,
  resolved_at DATETIME,
  result      TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel, id);
CREATE INDEX IF NOT EXISTS idx_messages_claimed ON messages(claimed_by);

-- Task queue for worker mode
CREATE TABLE IF NOT EXISTS tasks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  title               TEXT NOT NULL,
  description         TEXT DEFAULT '',
  source_path         TEXT,
  acceptance_criteria TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','claimed','in_progress','completed','failed','integrated','cycle')),
  priority            INTEGER NOT NULL DEFAULT 0,
  base_priority       INTEGER NOT NULL DEFAULT 0,
  claimed_by          TEXT,
  claimed_at          DATETIME,
  completed_at        DATETIME,
  result              TEXT,
  progress_log        TEXT,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority DESC, id ASC);

-- File registry — tracks which files are known to the coordination system.
-- claimant is the agent that currently owns writes (NULL = unowned).
-- Claims are sticky: they persist until explicit reconciliation, NOT until task completion.
CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,
  claimant   TEXT,
  claimed_at DATETIME
);

-- Join table: which tasks will write to which files.
CREATE TABLE IF NOT EXISTS task_files (
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_path  TEXT NOT NULL REFERENCES files(path),
  PRIMARY KEY (task_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_task_files_path ON task_files(file_path);

-- Task dependency graph
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on),
  CHECK (task_id != depends_on)
);
CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_deps_dep  ON task_dependencies(depends_on);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('group','direct')),
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member TEXT NOT NULL,
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (room_id, member)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  reply_to INTEGER REFERENCES chat_messages(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_room_id ON chat_messages(room_id, id);

CREATE TABLE IF NOT EXISTS teams (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  brief_path   TEXT,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','converging','dissolved')),
  deliverable  TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  dissolved_at DATETIME
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  role       TEXT NOT NULL,
  is_leader INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, agent_name)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_team_leader ON team_members(team_id) WHERE is_leader = 1;
`;

export let db: Database.Database;

export function openDb(dbPath: string): Database.Database {
  let instance = new Database(dbPath);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');

  instance.exec(SCHEMA_SQL);

  // Migration: add mode column to agents for existing DBs (v4 -> v5)
  try { instance.exec("ALTER TABLE agents ADD COLUMN mode TEXT NOT NULL DEFAULT 'single'"); } catch { /* column already exists */ }

  // Migration: add output/stderr columns to build_history (v5 -> v6)
  try { instance.exec("ALTER TABLE build_history ADD COLUMN output TEXT"); } catch { /* column already exists */ }
  try { instance.exec("ALTER TABLE build_history ADD COLUMN stderr TEXT"); } catch { /* column already exists */ }

  // Migration: expand tasks status CHECK constraint and add base_priority (v7 -> v9)
  // Uses writable_schema to patch the CHECK constraint in-place (no table rebuild).
  const schemaRow = instance.prepare('SELECT MIN(version) as version FROM schema_version').get() as { version: number } | undefined;
  if (!schemaRow || schemaRow.version < 9) {
    // v8→v9: add base_priority column BEFORE writable_schema (ALTER TABLE
    // cannot validate the schema after writable_schema modifies it in the
    // same connection — SQLite treats the rewritten SQL as unparsed text
    // until the next connection).
    try { instance.exec("ALTER TABLE tasks ADD COLUMN base_priority INTEGER NOT NULL DEFAULT 0"); } catch (e: any) { /* column already exists */ }
    instance.exec('UPDATE tasks SET base_priority = priority WHERE base_priority = 0 AND priority != 0');

    // v7→v8: expand CHECK constraint via writable_schema (no table rebuild needed).
    // SQLite caches the compiled schema per-connection, so writable_schema edits
    // only take effect after closing and reopening. We do that explicitly.
    let needsReopen = false;
    const tasksSchema = instance.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'"
    ).get() as { sql: string } | undefined;
    if (tasksSchema) {
      const oldCheck = "status IN ('pending','claimed','in_progress','completed','failed')";
      const newCheck = "status IN ('pending','claimed','in_progress','completed','failed','integrated','cycle')";
      if (tasksSchema.sql.includes(oldCheck)) {
        const fixedSql = tasksSchema.sql.replace(oldCheck, newCheck);
        instance.unsafeMode(true);
        instance.pragma('writable_schema = ON');
        instance.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'tasks'").run(fixedSql);
        instance.pragma('writable_schema = OFF');
        instance.unsafeMode(false);
        const sv = (instance.pragma('schema_version', { simple: true }) as number) || 0;
        instance.pragma(`schema_version = ${sv + 1}`);
        needsReopen = true;
      }
    }

    instance.exec('DELETE FROM schema_version WHERE version < 9');
    console.log('[db] Migrated to v9');

    // Reopen to pick up the writable_schema changes in the compiled schema cache.
    if (needsReopen) {
      const dbPath = instance.name;
      instance.close();
      instance = new Database(dbPath);
      instance.pragma('journal_mode = WAL');
      instance.pragma('foreign_keys = ON');
    }
  }

  // Migration: add container_host column to agents (v9 -> v10)
  if (!schemaRow || schemaRow.version < 10) {
    try { instance.exec("ALTER TABLE agents ADD COLUMN container_host TEXT"); } catch { /* already exists */ }
    instance.exec('DELETE FROM schema_version WHERE version < 10');
    instance.exec("INSERT OR IGNORE INTO schema_version(version) VALUES (10)");
    console.log('[db] Migrated to v10');
  }

  // Migration: add teams and team_members tables (v10 -> v11)
  if (!schemaRow || schemaRow.version < 11) {
    instance.exec('DELETE FROM schema_version WHERE version < 11');
    instance.exec("INSERT OR IGNORE INTO schema_version(version) VALUES (11)");
    console.log('[db] Migrated to v11');
  }

  // Migration: add session_token column to agents (v11 -> v12)
  // Always attempt the ALTER — the version check alone is unreliable because
  // CREATE TABLE IF NOT EXISTS won't add columns to an existing table, so a
  // DB whose schema_version was bumped to 12 on a fresh table (tests) may
  // still lack the column when reused against an older agents table.
  try { instance.exec("ALTER TABLE agents ADD COLUMN session_token TEXT"); } catch { /* already exists */ }
  try { instance.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_session_token ON agents(session_token)"); } catch { /* already exists */ }
  if (!schemaRow || schemaRow.version < 12) {
    instance.exec('DELETE FROM schema_version WHERE version < 12');
    instance.exec("INSERT OR IGNORE INTO schema_version(version) VALUES (12)");
    console.log('[db] Migrated to v12');
  }

  db = instance;
  return instance;
}
