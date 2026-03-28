#!/usr/bin/env npx tsx
/**
 * One-shot dump of the local SQLite coordination DB into Supabase.
 *
 * Usage:
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=ey... npx tsx server/scripts/dump-to-supabase.ts
 *
 * Re-runnable: uses upsert (ON CONFLICT DO UPDATE) so running twice is safe.
 * This is a read-only snapshot — it does NOT set up live sync.
 */

import Database from 'better-sqlite3';
import { createClient } from '@supabase/supabase-js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'coordination.db');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
  process.exit(1);
}

const sqlite = new Database(DB_PATH, { readonly: true });
sqlite.pragma('journal_mode = WAL');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Batch size for upserts (Supabase caps at ~1000 rows per request)
const BATCH = 500;

async function upsertBatch(table: string, rows: Record<string, unknown>[], conflictCol: string | string[]) {
  if (rows.length === 0) return;
  const onConflict = Array.isArray(conflictCol) ? conflictCol.join(',') : conflictCol;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict, ignoreDuplicates: false });
    if (error) {
      console.error(`  ERROR in ${table} (batch ${i / BATCH + 1}):`, error.message);
      throw error;
    }
  }
}

function readAll(table: string): Record<string, unknown>[] {
  return sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
}

/** SQLite stores booleans as 0/1. Postgres expects true/false. */
function intToBool(row: Record<string, unknown>, ...cols: string[]) {
  for (const col of cols) {
    if (col in row && row[col] !== null && row[col] !== undefined) {
      row[col] = row[col] === 1 || row[col] === true;
    }
  }
  return row;
}

async function dumpTable(
  table: string,
  conflictCol: string | string[],
  transform?: (row: Record<string, unknown>) => Record<string, unknown>,
) {
  const rows = readAll(table);
  const transformed = transform ? rows.map(transform) : rows;
  console.log(`  ${table}: ${transformed.length} rows`);
  if (transformed.length > 0) {
    await upsertBatch(table, transformed, conflictCol);
  }
}

async function main() {
  console.log(`Reading from: ${DB_PATH}`);
  console.log(`Writing to:   ${SUPABASE_URL}\n`);

  // Order matters: parents before children (foreign keys)

  // 1. Agents
  await dumpTable('agents', 'name', (row) => {
    // Supabase schema has extra columns (metadata, last_heartbeat) — leave as defaults
    delete (row as any).metadata;
    delete (row as any).last_heartbeat;
    return row;
  });

  // 2. UBT lock (singleton)
  await dumpTable('ubt_lock', 'id');

  // 3. UBT queue
  await dumpTable('ubt_queue', 'id');

  // 4. Build history
  await dumpTable('build_history', 'id', (row) => intToBool(row, 'success'));

  // 5. Messages
  await dumpTable('messages', 'id');

  // 6. Tasks
  await dumpTable('tasks', 'id');

  // 7. Files (must come before task_files)
  await dumpTable('files', 'path');

  // 8. Task-file join
  await dumpTable('task_files', 'task_id,file_path');

  // 9. Task dependencies
  await dumpTable('task_dependencies', 'task_id,depends_on');

  // 10. Rooms (must come before room_members and chat_messages)
  await dumpTable('rooms', 'id');

  // 11. Room members
  await dumpTable('room_members', 'room_id,member');

  // 12. Chat messages
  await dumpTable('chat_messages', 'id');

  // 13. Teams (must come before team_members)
  await dumpTable('teams', 'id');

  // 14. Team members
  await dumpTable('team_members', 'team_id,agent_name', (row) => intToBool(row, 'is_leader'));

  console.log('\nDone. Browse at: ' + SUPABASE_URL.replace('.supabase.co', '.supabase.co/project/default/editor'));
  sqlite.close();
}

main().catch((err) => {
  console.error('\nFatal:', err);
  process.exit(1);
});
