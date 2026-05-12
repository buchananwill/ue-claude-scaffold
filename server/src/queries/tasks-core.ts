import {
  eq,
  and,
  or,
  desc,
  asc,
  count as countFn,
  inArray,
  notInArray,
  isNull,
  type SQL,
} from "drizzle-orm";
import { tasks } from "../schema/tables.js";
import type { DrizzleDb } from "../drizzle-instance.js";
import { ACTIVE_STATUSES } from "./query-helpers.js";

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
      description: opts.description ?? "",
      sourcePath: opts.sourcePath ?? null,
      acceptanceCriteria: opts.acceptanceCriteria ?? null,
      priority,
      basePriority: priority,
      projectId: opts.projectId ?? "default",
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
  claimedBy: tasks.claimedByAgentId,
  createdAt: tasks.createdAt,
} as const;

export type SortColumn = keyof typeof SORTABLE_COLUMNS;

export const VALID_SORT_COLUMNS: readonly string[] =
  Object.keys(SORTABLE_COLUMNS);

/** Known task status values accepted by the API. Mirrors the schema CHECK
 *  constraint at server/src/schema/tables.ts (tasks_status_check) exactly:
 *  pending, claimed, the FSM mid-states (engineering, built, reviewing,
 *  revising, arbitrating), the FSM terminals (complete, failed, integrated),
 *  and the legacy 'cycle' sentinel still used by the dependency-graph code. */
export const VALID_TASK_STATUSES = [
  "pending",
  "claimed",
  "engineering",
  "built",
  "reviewing",
  "revising",
  "arbitrating",
  "completed",
  "failed",
  "integrated",
  "cycle",
] as const;

export interface ListOpts {
  status?: string[];
  agent?: string[];
  priority?: number[];
  /**
   * Filter by `tasks.claimed_by_agent_id` (an agent UUID, not a name slot).
   * Agent UUIDs are stable identity; names are reusable UI labels — the
   * container's startup probe uses this to recover only tasks claimed by
   * *this* agent's UUID, not by anyone who happens to share the name slot.
   */
  claimedByAgentId?: string;
  projectId?: string;
  limit?: number;
  offset?: number;
  sort?: SortColumn;
  dir?: "asc" | "desc";
}

/**
 * Build a filter condition for a nullable column where one special sentinel
 * value (e.g. '__unassigned__') maps to IS NULL, and the remaining values
 * match via eq/inArray. Handles three combinations:
 * sentinel+named -> OR(IS NULL, IN(...)), sentinel-only -> IS NULL,
 * named-only -> eq/inArray.
 */
function buildNullableSentinelFilter(
  column: typeof tasks.claimedByAgentId,
  values: string[],
  sentinel: string,
): SQL {
  const hasSentinel = values.includes(sentinel);
  const named = values.filter((v) => v !== sentinel);
  if (hasSentinel && named.length > 0) {
    const clause = or(isNull(column), inArray(column, named));
    if (!clause)
      throw new Error(
        "Invariant violation: or() returned undefined with two defined operands",
      );
    return clause;
  } else if (hasSentinel) {
    return isNull(column);
  } else if (named.length === 1) {
    return eq(column, named[0]);
  } else {
    return inArray(column, named);
  }
}

function buildFilterConditions(opts: {
  status?: string[];
  agent?: string[];
  priority?: number[];
  claimedByAgentId?: string;
  projectId?: string;
}): SQL[] {
  const conditions: SQL[] = [];

  if (opts.status && opts.status.length > 0) {
    if (opts.status.length === 1) {
      conditions.push(eq(tasks.status, opts.status[0]));
    } else {
      conditions.push(inArray(tasks.status, opts.status));
    }
  }
  if (opts.agent && opts.agent.length > 0) {
    conditions.push(
      buildNullableSentinelFilter(
        tasks.claimedByAgentId,
        opts.agent,
        "__unassigned__",
      ),
    );
  }
  if (opts.claimedByAgentId) {
    conditions.push(eq(tasks.claimedByAgentId, opts.claimedByAgentId));
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
    orderClauses.push(opts.dir === "desc" ? desc(col) : asc(col));
    // Tiebreaker: id ASC (unless already sorting by id)
    if (opts.sort !== "id") {
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
  claimedByAgentId?: string;
  projectId?: string;
}

export async function count(
  db: DrizzleDb,
  opts: CountOpts = {},
): Promise<number> {
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

export async function patch(
  db: DrizzleDb,
  id: number,
  fields: PatchFields,
): Promise<boolean> {
  const set: Record<string, unknown> = {};
  if (fields.title !== undefined) set.title = fields.title;
  if (fields.description !== undefined) set.description = fields.description;
  if (fields.sourcePath !== undefined) set.sourcePath = fields.sourcePath;
  if (fields.acceptanceCriteria !== undefined)
    set.acceptanceCriteria = fields.acceptanceCriteria;
  if (fields.priority !== undefined) set.priority = fields.priority;
  if (fields.status !== undefined) set.status = fields.status;

  if (Object.keys(set).length === 0) return false;

  const rows = await db
    .update(tasks)
    .set(set)
    .where(and(eq(tasks.id, id), eq(tasks.status, "pending")))
    .returning();

  return rows.length > 0;
}

export async function deleteByStatus(
  db: DrizzleDb,
  status: string,
  projectId: string,
): Promise<number> {
  const rows = await db
    .delete(tasks)
    .where(and(eq(tasks.status, status), eq(tasks.projectId, projectId)))
    .returning();
  return rows.length;
}

export async function deleteById(db: DrizzleDb, id: number): Promise<boolean> {
  // Refuse to delete tasks that are claimed or in any FSM mid-state. Mirrors
  // the route-layer guard at routes/tasks.ts; the inner guard exists so
  // direct callers of this helper (e.g. CLI-style consumers) cannot bypass
  // the FSM contract. Single source of truth: ACTIVE_STATUSES.
  const rows = await db
    .delete(tasks)
    .where(
      and(eq(tasks.id, id), notInArray(tasks.status, [...ACTIVE_STATUSES])),
    )
    .returning();
  return rows.length > 0;
}
