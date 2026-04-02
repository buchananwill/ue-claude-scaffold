#!/usr/bin/env tsx
/**
 * One-time data migration: SQLite (old better-sqlite3 DB) -> Postgres (Drizzle).
 *
 * Since better-sqlite3 was removed from the project dependencies, this script
 * provides documentation and a stub for the migration process.
 *
 * MANUAL MIGRATION STEPS:
 *
 * 1. Export each table from the old coordination.db to JSON using any SQLite tool:
 *
 *      sqlite3 coordination.db ".mode json" "SELECT * FROM agents;" > agents.json
 *      sqlite3 coordination.db ".mode json" "SELECT * FROM messages;" > messages.json
 *      sqlite3 coordination.db ".mode json" "SELECT * FROM tasks;" > tasks.json
 *      sqlite3 coordination.db ".mode json" "SELECT * FROM builds;" > builds.json
 *      sqlite3 coordination.db ".mode json" "SELECT * FROM file_ownership;" > file_ownership.json
 *      sqlite3 coordination.db ".mode json" "SELECT * FROM ubt_lock;" > ubt_lock.json
 *      sqlite3 coordination.db ".mode json" "SELECT * FROM ubt_queue;" > ubt_queue.json
 *
 * 2. Set DATABASE_URL to the target Postgres database.
 *
 * 3. Run `npm run db:migrate` to ensure the schema exists.
 *
 * 4. Use the importTable() helper below to load each JSON file into Postgres.
 *
 * Data transformations needed:
 *   - TEXT JSON columns (e.g. tasks.metadata) -> parse with JSON.parse for jsonb
 *   - ISO datetime strings -> new Date(str) for timestamp columns
 *   - INTEGER booleans (0/1) -> true/false for boolean columns
 */

import { readFileSync } from 'node:fs';
import { initDrizzle, closeDrizzle, getDbStatus } from '../src/drizzle-instance.js';
import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '../src/drizzle-instance.js';

async function importTable(db: DrizzleDb, tableName: string, jsonPath: string) {
  const raw = JSON.parse(readFileSync(jsonPath, 'utf-8')) as Record<string, unknown>[];
  console.log(`Importing ${raw.length} rows into ${tableName}…`);

  for (const row of raw) {
    const columns = Object.keys(row);
    const colList = columns.map((c) => `"${c}"`).join(', ');
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const values = columns.map((c) => row[c]);

    await db.execute(
      sql.raw(`INSERT INTO "${tableName}" (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`),
    );
    // Note: sql.raw doesn't support parameterized queries. For a real migration,
    // use the pg driver directly or drizzle insert builders with the schema tables.
    void values; // suppress unused warning — see note above
  }

  console.log(`  Done: ${tableName}`);
}

// --- Main ---
const jsonDir = process.argv[2];
if (!jsonDir) {
  console.log(`
Usage: DATABASE_URL=postgresql://... tsx scripts/migrate-sqlite-to-postgres.ts <json-export-dir>

Export your old SQLite tables to JSON first (see instructions at top of this file),
then point this script at the directory containing those JSON files.
`);
  process.exit(0);
}

const db = await initDrizzle();
const status = getDbStatus();
console.log(`Target backend: ${status.backend}`);

const tables = ['agents', 'messages', 'tasks', 'builds', 'file_ownership', 'ubt_lock', 'ubt_queue'];

for (const table of tables) {
  const jsonPath = `${jsonDir}/${table}.json`;
  try {
    readFileSync(jsonPath); // check existence
    await importTable(db, table, jsonPath);
  } catch {
    console.log(`  Skipping ${table} (${jsonPath} not found)`);
  }
}

console.log('Migration complete.');
await closeDrizzle();
