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
INSERT OR IGNORE INTO schema_version(version) VALUES (1);

-- Agent registration and status
CREATE TABLE IF NOT EXISTS agents (
  name        TEXT PRIMARY KEY,
  worktree    TEXT NOT NULL,
  plan_doc    TEXT,
  status      TEXT NOT NULL DEFAULT 'idle',
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
CREATE INDEX IF NOT EXISTS idx_messages_claimed ON messages(claimed_by);
`;

export let db: Database.Database;

export function openDb(dbPath: string): Database.Database {
  const instance = new Database(dbPath);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');

  instance.exec(SCHEMA_SQL);

  db = instance;
  return instance;
}
