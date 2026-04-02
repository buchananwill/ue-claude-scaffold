import { eq, sql } from 'drizzle-orm';
import { projects } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

export interface ProjectRow {
  id: string;
  name: string;
  engineVersion: string | null;
  seedBranch: string | null;
  buildTimeoutMs: number | null;
  testTimeoutMs: number | null;
  createdAt: Date | null;
}

export interface CreateProjectOpts {
  id: string;
  name: string;
  engineVersion?: string | null;
  seedBranch?: string | null;
  buildTimeoutMs?: number | null;
  testTimeoutMs?: number | null;
}

export interface UpdateProjectOpts {
  name?: string;
  engineVersion?: string | null;
  seedBranch?: string | null;
  buildTimeoutMs?: number | null;
  testTimeoutMs?: number | null;
}

const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidProjectId(id: string): boolean {
  return PROJECT_ID_PATTERN.test(id);
}

export async function getAll(db: DrizzleDb): Promise<ProjectRow[]> {
  return db.select().from(projects) as Promise<ProjectRow[]>;
}

export async function getById(db: DrizzleDb, id: string): Promise<ProjectRow | null> {
  const rows = await db.select().from(projects).where(eq(projects.id, id));
  return (rows[0] as ProjectRow) ?? null;
}

export async function create(db: DrizzleDb, opts: CreateProjectOpts): Promise<ProjectRow> {
  const rows = await db
    .insert(projects)
    .values({
      id: opts.id,
      name: opts.name,
      engineVersion: opts.engineVersion ?? null,
      seedBranch: opts.seedBranch ?? null,
      buildTimeoutMs: opts.buildTimeoutMs ?? null,
      testTimeoutMs: opts.testTimeoutMs ?? null,
    })
    .returning();
  return rows[0] as ProjectRow;
}

export async function update(db: DrizzleDb, id: string, opts: UpdateProjectOpts): Promise<ProjectRow | null> {
  const set: Record<string, unknown> = {};
  if (opts.name !== undefined) set.name = opts.name;
  if (opts.engineVersion !== undefined) set.engineVersion = opts.engineVersion;
  if (opts.seedBranch !== undefined) set.seedBranch = opts.seedBranch;
  if (opts.buildTimeoutMs !== undefined) set.buildTimeoutMs = opts.buildTimeoutMs;
  if (opts.testTimeoutMs !== undefined) set.testTimeoutMs = opts.testTimeoutMs;

  if (Object.keys(set).length === 0) {
    return getById(db, id);
  }

  const rows = await db
    .update(projects)
    .set(set)
    .where(eq(projects.id, id))
    .returning();
  return (rows[0] as ProjectRow) ?? null;
}

export async function remove(db: DrizzleDb, id: string): Promise<boolean> {
  const rows = await db.delete(projects).where(eq(projects.id, id)).returning();
  return rows.length > 0;
}

/**
 * Seed projects from config JSON. INSERT-only: skip if already exists.
 */
export async function seedFromConfig(db: DrizzleDb, projectIds: string[]): Promise<{ inserted: string[]; skipped: string[] }> {
  const inserted: string[] = [];
  const skipped: string[] = [];

  for (const id of projectIds) {
    if (!isValidProjectId(id)) {
      skipped.push(id);
      continue;
    }
    const existing = await getById(db, id);
    if (existing) {
      skipped.push(id);
    } else {
      await create(db, { id, name: id });
      inserted.push(id);
    }
  }

  return { inserted, skipped };
}

/**
 * Check if any data references the given project ID across tables.
 * Used to prevent deletion of projects that still have associated data.
 */
export async function hasReferencingData(db: DrizzleDb, projectId: string): Promise<boolean> {
  // Import all tables that have project_id
  const { agents, buildHistory, messages, tasks, files, ubtLock, ubtQueue, rooms, teams } = await import('../schema/tables.js');

  const tablesToCheck = [
    { table: agents, col: agents.projectId },
    { table: buildHistory, col: buildHistory.projectId },
    { table: messages, col: messages.projectId },
    { table: tasks, col: tasks.projectId },
    { table: files, col: files.projectId },
    { table: ubtLock, col: ubtLock.projectId },
    { table: ubtQueue, col: ubtQueue.projectId },
    { table: rooms, col: rooms.projectId },
    { table: teams, col: teams.projectId },
  ];

  for (const { table, col } of tablesToCheck) {
    const rows = await db.select({ one: sql`1` }).from(table).where(eq(col, projectId)).limit(1);
    if (rows.length > 0) {
      return true;
    }
  }

  return false;
}
