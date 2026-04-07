import { eq, and, or, desc, asc, sql, count as countFn, inArray, isNull, type SQL } from 'drizzle-orm';
import { tasks } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

/** Drizzle inferred row type for the tasks table. */
export type TaskDbRow = typeof tasks.$inferSelect;

/** Default number of tasks returned by list queries. */
export const DEFAULT_LIST_LIMIT = 20;

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

/** Columns that can appear in the `sort` query param. */
const SORTABLE_COLUMNS = {
  id: tasks.id,
  priority: tasks.priority,
  status: tasks.status,
  title: tasks.title,
  claimedBy: tasks.claimedBy,
  createdAt: tasks.createdAt,
} as const;

export type SortColumn = keyof typeof SORTABLE_COLUMNS;

export const VALID_SORT_COLUMNS: readonly string[] = Object.keys(SORTABLE_COLUMNS);

/** Known task status values accepted by the API. */
export const VALID_TASK_STATUSES = ['pending', 'claimed', 'in_progress', 'completed', 'failed', 'integrated', 'cycle'] as const;

export interface ListOpts {
  status?: string[];
  agent?: string[];
  priority?: number[];
  projectId?: string;
  limit?: number;
  offset?: number;
  sort?: SortColumn;
  dir?: 'asc' | 'desc';
}

function buildFilterConditions(opts: { status?: string[]; agent?: string[]; priority?: number[]; projectId?: string }): SQL[] {
  const conditions: SQL[] = [];

  if (opts.status && opts.status.length > 0) {
    if (opts.status.length === 1) {
      conditions.push(eq(tasks.status, opts.status[0]));
    } else {
      conditions.push(inArray(tasks.status, opts.status));
    }
  }
  if (opts.agent && opts.agent.length > 0) {
    const unassigned = opts.agent.includes('__unassigned__');
    const named = opts.agent.filter(a => a !== '__unassigned__');
    if (unassigned && named.length > 0) {
      // claimedBy IS NULL OR claimedBy IN (...)
      conditions.push(or(isNull(tasks.claimedBy), inArray(tasks.claimedBy, named))!);
    } else if (unassigned) {
      conditions.push(isNull(tasks.claimedBy));
    } else {
      if (named.length === 1) {
        conditions.push(eq(tasks.claimedBy, named[0]));
      } else {
        conditions.push(inArray(tasks.claimedBy, named));
      }
    }
  }
  if (opts.priority && opts.priority.length > 0) {
    if (opts.priority.length === 1) {
      conditions.push(eq(tasks.priority, opts.priority[0]));
    } else {
      conditions.push(inArray(tasks.priority, opts.priority));
    }
  }
  if (opts.projectId) {
    conditions.push(eq(tasks.projectId, opts.projectId));
  }

  return conditions;
}

export async function list(db: DrizzleDb, opts: ListOpts = {}) {
  const conditions = buildFilterConditions(opts);

  const limitVal = opts.limit ?? DEFAULT_LIST_LIMIT;
  const offsetVal = opts.offset ?? 0;

  // Build ORDER BY clause
  const orderClauses: SQL[] = [];
  if (opts.sort && opts.sort in SORTABLE_COLUMNS) {
    const col = SORTABLE_COLUMNS[opts.sort];
    orderClauses.push(opts.dir === 'desc' ? desc(col) : asc(col));
    // Tiebreaker: id ASC (unless already sorting by id)
    if (opts.sort !== 'id') {
      orderClauses.push(asc(tasks.id));
    }
  } else {
    // Default sort: priority DESC, id ASC
    orderClauses.push(desc(tasks.priority));
    orderClauses.push(asc(tasks.id));
  }

  return db
    .select()
    .from(tasks)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...orderClauses)
    .limit(limitVal)
    .offset(offsetVal);
}

export interface CountOpts {
  status?: string[];
  agent?: string[];
  priority?: number[];
  projectId?: string;
}

export async function count(db: DrizzleDb, opts: CountOpts = {}): Promise<number> {
  const conditions = buildFilterConditions(opts);

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
