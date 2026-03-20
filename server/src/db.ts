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
INSERT OR IGNORE INTO schema_version(version) VALUES (7);

-- Agent registration and status
CREATE TABLE IF NOT EXISTS agents (
  name        TEXT PRIMARY KEY,
  worktree    TEXT NOT NULL,
  plan_doc    TEXT,
  status      TEXT NOT NULL DEFAULT 'idle',
  mode        TEXT NOT NULL DEFAULT 'single',
  registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  description         TEXT NOT NULL DEFAULT '',
  source_path         TEXT,
  acceptance_criteria TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','claimed','in_progress','completed','failed')),
  priority            INTEGER NOT NULL DEFAULT 0,
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
`;

export let db: Database.Database;

export function openDb(dbPath: string): Database.Database {
  const instance = new Database(dbPath);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');

  instance.exec(SCHEMA_SQL);

  // Migration: add mode column to agents for existing DBs (v4 -> v5)
  try { instance.exec("ALTER TABLE agents ADD COLUMN mode TEXT NOT NULL DEFAULT 'single'"); } catch { /* column already exists */ }

  // Migration: add output/stderr columns to build_history (v5 -> v6)
  try { instance.exec("ALTER TABLE build_history ADD COLUMN output TEXT"); } catch { /* column already exists */ }
  try { instance.exec("ALTER TABLE build_history ADD COLUMN stderr TEXT"); } catch { /* column already exists */ }

  db = instance;
  return instance;
}
