import { eq, and, desc, asc, sql, count as countFn, inArray } from 'drizzle-orm';
import { tasks } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

export interface InsertOpts {
  title: string;
  description?: string;
  sourcePath?: string;
  acceptanceCriteria?: string;
  priority?: number;
  projectId?: string;
}

export async function insert(db: DrizzleDb, opts: InsertOpts) {
  const priority = opts.priority ?? 0;
  const rows = await db
    .insert(tasks)
    .values({
      title: opts.title,
      description: opts.description ?? '',
      sourcePath: opts.sourcePath ?? null,
      acceptanceCriteria: opts.acceptanceCriteria ?? null,
      priority,
      basePriority: priority,
      projectId: opts.projectId ?? 'default',
    })
    .returning();
  return rows[0];
}

export async function getById(db: DrizzleDb, id: number) {
  const rows = await db.select().from(tasks).where(eq(tasks.id, id));
  return rows[0] ?? null;
}

export interface ListOpts {
  status?: string;
  projectId?: string;
  limit?: number;
  offset?: number;
}

export async function list(db: DrizzleDb, opts: ListOpts = {}) {
  const conditions = [];

  if (opts.status) {
    conditions.push(eq(tasks.status, opts.status));
  }
  if (opts.projectId) {
    conditions.push(eq(tasks.projectId, opts.projectId));
  }

  const limitVal = opts.limit ?? 100;
  const offsetVal = opts.offset ?? 0;

  return db
    .select()
    .from(tasks)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(tasks.priority), asc(tasks.id))
    .limit(limitVal)
    .offset(offsetVal);
}

export interface CountOpts {
  status?: string;
  projectId?: string;
}

export async function count(db: DrizzleDb, opts: CountOpts = {}): Promise<number> {
  const conditions = [];

  if (opts.status) {
    conditions.push(eq(tasks.status, opts.status));
  }
  if (opts.projectId) {
    conditions.push(eq(tasks.projectId, opts.projectId));
  }

  const rows = await db
    .select({ count: countFn() })
    .from(tasks)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return Number(rows[0].count);
}

export type PatchFields = Partial<{
  title: string;
  description: string;
  sourcePath: string;
  acceptanceCriteria: string;
  priority: number;
  status: string;
}>;

export async function patch(db: DrizzleDb, id: number, fields: PatchFields): Promise<boolean> {
  const set: Record<string, unknown> = {};
  if (fields.title !== undefined) set.title = fields.title;
  if (fields.description !== undefined) set.description = fields.description;
  if (fields.sourcePath !== undefined) set.sourcePath = fields.sourcePath;
  if (fields.acceptanceCriteria !== undefined) set.acceptanceCriteria = fields.acceptanceCriteria;
  if (fields.priority !== undefined) set.priority = fields.priority;
  if (fields.status !== undefined) set.status = fields.status;

  if (Object.keys(set).length === 0) return false;

  const rows = await db
    .update(tasks)
    .set(set)
    .where(and(eq(tasks.id, id), eq(tasks.status, 'pending')))
    .returning();

  return rows.length > 0;
}

export async function deleteByStatus(db: DrizzleDb, status: string): Promise<number> {
  const rows = await db
    .delete(tasks)
    .where(eq(tasks.status, status))
    .returning();
  return rows.length;
}

export async function deleteById(db: DrizzleDb, id: number): Promise<boolean> {
  const rows = await db
    .delete(tasks)
    .where(
      and(
        eq(tasks.id, id),
        sql`${tasks.status} NOT IN ('claimed', 'in_progress')`,
      ),
    )
    .returning();
  return rows.length > 0;
}
