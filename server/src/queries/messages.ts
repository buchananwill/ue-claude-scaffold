import { eq, and, gt, lt, desc, asc, sql, isNull, count as countFn } from 'drizzle-orm';
import { messages } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

export interface InsertOpts {
  fromAgent: string;
  channel: string;
  type: string;
  payload: unknown;
  projectId?: string;
}

export async function insert(db: DrizzleDb, opts: InsertOpts): Promise<number> {
  const rows = await db
    .insert(messages)
    .values({
      fromAgent: opts.fromAgent,
      channel: opts.channel,
      type: opts.type,
      payload: opts.payload,
      projectId: opts.projectId ?? 'default',
    })
    .returning();
  return rows[0].id;
}

export interface ListOpts {
  channel?: string;
  since?: number;
  before?: number;
  type?: string;
  fromAgent?: string;
  limit?: number;
  projectId?: string;
}

export async function list(db: DrizzleDb, opts: ListOpts = {}) {
  const conditions = [];

  if (opts.channel) {
    conditions.push(eq(messages.channel, opts.channel));
  }
  if (opts.type) {
    conditions.push(eq(messages.type, opts.type));
  }
  if (opts.fromAgent) {
    conditions.push(eq(messages.fromAgent, opts.fromAgent));
  }
  if (opts.projectId) {
    conditions.push(eq(messages.projectId, opts.projectId));
  }

  // Polling mode: since => ORDER BY id ASC, capped by limit when provided
  if (opts.since != null) {
    conditions.push(gt(messages.id, opts.since));
    const query = db
      .select()
      .from(messages)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(messages.id));
    if (opts.limit != null) {
      return query.limit(opts.limit);
    }
    return query;
  }

  // Paging mode: before => ORDER BY id DESC LIMIT n, then reverse
  if (opts.before != null) {
    conditions.push(lt(messages.id, opts.before));
  }

  const pageSize = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = await db
    .select()
    .from(messages)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(messages.id))
    .limit(pageSize);

  rows.reverse();
  return rows;
}

export interface CountOpts {
  channel?: string;
  type?: string;
  fromAgent?: string;
  projectId?: string;
}

export async function count(db: DrizzleDb, opts: CountOpts = {}): Promise<number> {
  const conditions = [];

  if (opts.channel) {
    conditions.push(eq(messages.channel, opts.channel));
  }
  if (opts.type) {
    conditions.push(eq(messages.type, opts.type));
  }
  if (opts.fromAgent) {
    conditions.push(eq(messages.fromAgent, opts.fromAgent));
  }
  if (opts.projectId) {
    conditions.push(eq(messages.projectId, opts.projectId));
  }

  const rows = await db
    .select({ count: countFn() })
    .from(messages)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return Number(rows[0].count);
}

export async function claim(db: DrizzleDb, id: number, claimedBy: string): Promise<boolean> {
  const rows = await db
    .update(messages)
    .set({ claimedBy, claimedAt: sql`now()` })
    .where(and(eq(messages.id, id), isNull(messages.claimedBy)))
    .returning();
  return rows.length > 0;
}

export async function resolve(db: DrizzleDb, id: number, result: unknown) {
  await db
    .update(messages)
    .set({ resolvedAt: sql`now()`, result })
    .where(eq(messages.id, id));
}

export async function deleteById(db: DrizzleDb, id: number): Promise<boolean> {
  const rows = await db
    .delete(messages)
    .where(eq(messages.id, id))
    .returning();
  return rows.length > 0;
}

export async function deleteByChannel(db: DrizzleDb, channel: string): Promise<number> {
  const rows = await db
    .delete(messages)
    .where(eq(messages.channel, channel))
    .returning();
  return rows.length;
}

export async function deleteByChannelBefore(
  db: DrizzleDb,
  channel: string,
  beforeId: number,
): Promise<number> {
  const rows = await db
    .delete(messages)
    .where(and(eq(messages.channel, channel), lt(messages.id, beforeId)))
    .returning();
  return rows.length;
}
