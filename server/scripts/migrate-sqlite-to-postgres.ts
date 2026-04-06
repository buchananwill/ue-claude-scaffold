#!/usr/bin/env tsx
/**
 * One-time data migration: SQLite (old coordination.db) → PGLite (Drizzle).
 *
 * Reads data from the old better-sqlite3 database via the sqlite3 CLI tool
 * (better-sqlite3 has been removed from project dependencies) and inserts
 * into PGLite with project_id='piste-perfect' on all project-scoped tables.
 *
 * Usage:
 *   cd server
 *   npx tsx scripts/migrate-sqlite-to-postgres.ts
 *
 * Idempotent: uses ON CONFLICT DO NOTHING on all inserts.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { initDrizzle, closeDrizzle, getDbStatus } from '../src/drizzle-instance.js';
import type { DrizzleDb } from '../src/drizzle-instance.js';
import {
  agents,
  buildHistory,
  messages,
  tasks,
  taskFiles,
  taskDependencies,
  files,
  rooms,
  roomMembers,
  chatMessages,
  teams,
  teamMembers,
} from '../src/schema/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQLITE3_EXE = 'sqlite3.exe';
const SQLITE_DB = resolve(__dirname, '..', 'coordination.db');
const PGLITE_DIR = './data/pglite';
const PROJECT_ID = 'piste-perfect';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readSqliteTable(tableName: string): Record<string, unknown>[] {
  const cmd = `${SQLITE3_EXE} "${SQLITE_DB}" ".mode json" "SELECT * FROM ${tableName};"`;
  const stdout = execSync(cmd, {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  }).trim();
  if (!stdout) return [];
  return JSON.parse(stdout) as Record<string, unknown>[];
}

function toDate(val: unknown): Date | null {
  if (val == null || val === '') return null;
  return new Date(String(val));
}

function toJsonb(val: unknown): unknown {
  if (val == null || val === '') return null;
  if (typeof val === 'object') return val; // already parsed (shouldn't happen with sqlite3 CLI)
  try {
    return JSON.parse(String(val));
  } catch {
    return String(val);
  }
}

function toBool(val: unknown): boolean {
  return !!val && val !== 0 && val !== '0';
}

async function batchInsert(
  db: DrizzleDb,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[],
  chunkSize = 200,
): Promise<number> {
  if (rows.length === 0) return 0;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await db.insert(table).values(chunk).onConflictDoNothing();
    inserted += chunk.length;
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Per-table mappers
// ---------------------------------------------------------------------------

function mapAgents(rows: Record<string, unknown>[]) {
  return rows.map((r) => ({
    name: String(r.name),
    projectId: PROJECT_ID,
    worktree: String(r.worktree),
    planDoc: r.plan_doc != null ? String(r.plan_doc) : null,
    status: String(r.status ?? 'idle'),
    mode: String(r.mode ?? 'single'),
    registeredAt: toDate(r.registered_at),
    containerHost: r.container_host != null ? String(r.container_host) : null,
    sessionToken: r.session_token != null ? String(r.session_token) : null,
  }));
}

function mapRooms(rows: Record<string, unknown>[]) {
  return rows.map((r) => ({
    id: String(r.id),
    projectId: PROJECT_ID,
    name: String(r.name),
    type: String(r.type),
    createdBy: String(r.created_by),
    createdAt: toDate(r.created_at),
  }));
}

function mapRoomMembers(rows: Record<string, unknown>[]) {
  return rows.map((r) => ({
    roomId: String(r.room_id),
    member: String(r.member),
    joinedAt: toDate(r.joined_at),
  }));
}

function mapTeams(rows: Record<string, unknown>[]) {
  return rows.map((r) => ({
    id: String(r.id),
    projectId: PROJECT_ID,
    name: String(r.name),
    briefPath: r.brief_path != null ? String(r.brief_path) : null,
    status: String(r.status ?? 'active'),
    deliverable: r.deliverable != null ? String(r.deliverable) : null,
    createdAt: toDate(r.created_at),
    dissolvedAt: toDate(r.dissolved_at),
  }));
}

function mapTeamMembers(rows: Record<string, unknown>[]) {
  return rows.map((r) => ({
    teamId: String(r.team_id),
    agentName: String(r.agent_name),
    role: String(r.role),
    isLeader: toBool(r.is_leader),
  }));
}

function mapTasks(rows: Record<string, unknown>[]) {
  return rows.map((r) => ({
    id: Number(r.id),
    projectId: PROJECT_ID,
    title: String(r.title),
    description: r.description != null ? String(r.description) : '',
    sourcePath: r.source_path != null ? String(r.source_path) : null,
    acceptanceCriteria: r.acceptance_criteria != null ? String(r.acceptance_criteria) : null,
    status: String(r.status ?? 'pending'),
    priority: Number(r.priority ?? 0),
    basePriority: Number(r.base_priority ?? 0),
    claimedBy: r.claimed_by != null ? String(r.claimed_by) : null,
    claimedAt: toDate(r.claimed_at),
    completedAt: toDate(r.completed_at),
    result: toJsonb(r.result),
    progressLog: r.progress_log != null ? String(r.progress_log) : null,
    createdAt: toDate(r.created_at),
  }));
}

function mapTaskFiles(rows: Record<string, unknown>[]) {
  return rows.map((r) => ({
    taskId: Number(r.task_id),
    filePath: String(r.file_path),
  }));
}

function mapTaskDependencies(rows: Record<string, unknown>[]) {
  return rows.map((r) => ({
    taskId: Number(r.task_id),
    dependsOn: Number(r.depends_on),
  }));
}

function mapMessages(rows: Record<string, unknown>[]) {
  return rows.map((r) => ({
    id: Number(r.id),
    projectId: PROJECT_ID,
    fromAgent: String(r.from_agent),
    channel: String(r.channel),
    type: String(r.type),
    payload: toJsonb(r.payload),
    claimedBy: r.claimed_by != null ? String(r.claimed_by) : null,
    claimedAt: toDate(r.claimed_at),
    resolvedAt: toDate(r.resolved_at),
    result: toJsonb(r.result),
    createdAt: toDate(r.created_at),
  }));
}

function mapBuildHistory(rows: Record<string, unknown>[]) {
  return rows.map((r) => ({
    id: Number(r.id),
    projectId: PROJECT_ID,
    agent: String(r.agent),
    type: String(r.type),
    startedAt: toDate(r.started_at) ?? new Date(),
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
    success: r.success != null ? Number(r.success) : null,
    output: r.output != null ? String(r.output) : null,
    stderr: r.stderr != null ? String(r.stderr) : null,
  }));
}

function mapChatMessages(rows: Record<string, unknown>[]) {
  return rows.map((r) => ({
    id: Number(r.id),
    roomId: String(r.room_id),
    sender: String(r.sender),
    content: String(r.content),
    replyTo: r.reply_to != null ? Number(r.reply_to) : null,
    createdAt: toDate(r.created_at),
  }));
}

function mapFiles(rows: Record<string, unknown>[]) {
  return rows.map((r) => ({
    projectId: PROJECT_ID,
    path: String(r.path),
    claimant: r.claimant != null ? String(r.claimant) : null,
    claimedAt: toDate(r.claimed_at),
  }));
}

// ---------------------------------------------------------------------------
// Sequence resets
// ---------------------------------------------------------------------------

async function resetSequences(db: DrizzleDb): Promise<void> {
  const serialTables = [
    { table: 'tasks', column: 'id' },
    { table: 'build_history', column: 'id' },
    { table: 'messages', column: 'id' },
    { table: 'chat_messages', column: 'id' },
    { table: 'ubt_queue', column: 'id' },
  ];

  for (const { table, column } of serialTables) {
    await db.execute(sql.raw(
      `SELECT setval(pg_get_serial_sequence('${table}', '${column}'), COALESCE((SELECT MAX("${column}") FROM "${table}"), 1))`
    ));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface MigrationStep {
  name: string;
  sqliteTable: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  drizzleTable: any;
  mapper: (rows: Record<string, unknown>[]) => unknown[];
}

const steps: MigrationStep[] = [
  { name: 'agents',            sqliteTable: 'agents',            drizzleTable: agents,           mapper: mapAgents },
  { name: 'rooms',             sqliteTable: 'rooms',             drizzleTable: rooms,            mapper: mapRooms },
  { name: 'room_members',      sqliteTable: 'room_members',      drizzleTable: roomMembers,      mapper: mapRoomMembers },
  { name: 'teams',             sqliteTable: 'teams',             drizzleTable: teams,            mapper: mapTeams },
  { name: 'team_members',      sqliteTable: 'team_members',      drizzleTable: teamMembers,      mapper: mapTeamMembers },
  { name: 'tasks',             sqliteTable: 'tasks',             drizzleTable: tasks,            mapper: mapTasks },
  { name: 'task_files',        sqliteTable: 'task_files',        drizzleTable: taskFiles,        mapper: mapTaskFiles },
  { name: 'task_dependencies', sqliteTable: 'task_dependencies', drizzleTable: taskDependencies, mapper: mapTaskDependencies },
  { name: 'messages',          sqliteTable: 'messages',          drizzleTable: messages,         mapper: mapMessages },
  { name: 'build_history',     sqliteTable: 'build_history',     drizzleTable: buildHistory,     mapper: mapBuildHistory },
  { name: 'chat_messages',     sqliteTable: 'chat_messages',     drizzleTable: chatMessages,     mapper: mapChatMessages },
  { name: 'files',             sqliteTable: 'files',             drizzleTable: files,            mapper: mapFiles },
];

async function main() {
  // Validate prerequisites
  if (!existsSync(SQLITE_DB)) {
    console.error(`SQLite database not found: ${SQLITE_DB}`);
    process.exit(1);
  }

  try {
    execSync(`${SQLITE3_EXE} --version`, { encoding: 'utf-8' });
  } catch {
    console.error(`sqlite3 CLI not found. Install via: choco install sqlite`);
    process.exit(1);
  }

  console.log(`Source:  ${SQLITE_DB}`);
  console.log(`Target:  PGLite at ${PGLITE_DIR}`);
  console.log(`Project: ${PROJECT_ID}`);
  console.log();

  // Init PGLite + run Drizzle migrations
  const db = await initDrizzle({ pgliteDataDir: PGLITE_DIR });
  const status = getDbStatus();
  console.log(`Backend: ${status.backend}`);
  console.log();

  // Migrate each table
  const results: Array<{ name: string; read: number; written: number }> = [];

  for (const step of steps) {
    process.stdout.write(`  ${step.name.padEnd(20)}`);
    const raw = readSqliteTable(step.sqliteTable);
    const mapped = step.mapper(raw);
    const written = await batchInsert(db, step.drizzleTable, mapped);
    results.push({ name: step.name, read: raw.length, written });
    console.log(`${String(raw.length).padStart(5)} read → ${String(written).padStart(5)} queued`);
  }

  // Reset serial sequences
  console.log();
  console.log('Resetting serial sequences...');
  await resetSequences(db);

  // Summary
  console.log();
  console.log('=== Migration Summary ===');
  console.log(`${'Table'.padEnd(22)} ${'Read'.padStart(6)} ${'Queued'.padStart(8)}`);
  console.log('-'.repeat(38));
  let totalRead = 0;
  let totalWritten = 0;
  for (const r of results) {
    console.log(`${r.name.padEnd(22)} ${String(r.read).padStart(6)} ${String(r.written).padStart(8)}`);
    totalRead += r.read;
    totalWritten += r.written;
  }
  console.log('-'.repeat(38));
  console.log(`${'TOTAL'.padEnd(22)} ${String(totalRead).padStart(6)} ${String(totalWritten).padStart(8)}`);
  console.log();
  console.log('Done. All rows use project_id=' + PROJECT_ID);

  await closeDrizzle();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
