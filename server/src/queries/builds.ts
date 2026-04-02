import { eq, and, gt, desc, sql, avg } from 'drizzle-orm';
import { buildHistory } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

export interface InsertHistoryOpts {
  agent: string;
  type: string;
  projectId?: string;
}

export async function insertHistory(db: DrizzleDb, opts: InsertHistoryOpts): Promise<number> {
  const rows = await db
    .insert(buildHistory)
    .values({
      agent: opts.agent,
      type: opts.type,
      projectId: opts.projectId ?? 'default',
    })
    .returning();
  return rows[0].id;
}

export interface UpdateHistoryOpts {
  durationMs: number;
  success: boolean;
  output?: string;
  stderr?: string;
}

export async function updateHistory(db: DrizzleDb, id: number, opts: UpdateHistoryOpts) {
  await db
    .update(buildHistory)
    .set({
      durationMs: opts.durationMs,
      success: opts.success ? 1 : 0,
      output: opts.output ?? null,
      stderr: opts.stderr ?? null,
    })
    .where(eq(buildHistory.id, id));
}

export async function avgDuration(db: DrizzleDb, type: string): Promise<number | null> {
  // Average of last 5 successful builds' duration_ms
  const subquery = db
    .select({ durationMs: buildHistory.durationMs })
    .from(buildHistory)
    .where(
      and(
        eq(buildHistory.type, type),
        eq(buildHistory.success, 1),
        sql`${buildHistory.durationMs} IS NOT NULL`,
      ),
    )
    .orderBy(desc(buildHistory.id))
    .limit(5)
    .as('sub');

  const rows = await db
    .select({ avg: avg(subquery.durationMs) })
    .from(subquery);

  const val = rows[0]?.avg;
  return val != null ? Math.round(Number(val)) : null;
}

export async function lastCompleted(db: DrizzleDb, agent: string, type: string) {
  const rows = await db
    .select()
    .from(buildHistory)
    .where(
      and(
        eq(buildHistory.agent, agent),
        eq(buildHistory.type, type),
        sql`${buildHistory.durationMs} IS NOT NULL`,
      ),
    )
    .orderBy(desc(buildHistory.id))
    .limit(1);
  return rows[0] ?? null;
}

export interface ListOpts {
  agent?: string;
  type?: string;
  since?: number;
  project?: string;
  limit?: number;
}

export async function list(db: DrizzleDb, opts: ListOpts = {}) {
  const conditions = [];

  if (opts.agent) {
    conditions.push(eq(buildHistory.agent, opts.agent));
  }
  if (opts.type) {
    conditions.push(eq(buildHistory.type, opts.type));
  }
  if (opts.since != null) {
    conditions.push(gt(buildHistory.id, opts.since));
  }
  if (opts.project) {
    conditions.push(eq(buildHistory.projectId, opts.project));
  }

  const limitVal = Math.max(1, Math.min(opts.limit ?? 50, 500));

  return db
    .select()
    .from(buildHistory)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(buildHistory.id))
    .limit(limitVal);
}
