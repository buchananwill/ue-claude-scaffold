import { eq, and, sql, inArray, type SQL } from 'drizzle-orm';
import { tasks } from '../schema/tables.js';
import type { DrizzleDb, DbOrTx } from '../drizzle-instance.js';
import type { TaskDbRow } from './tasks-core.js';
import { ACTIVE_STATUSES } from './query-helpers.js';

export async function claim(db: DrizzleDb, projectId: string, id: number, agentId: string): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({
      status: 'claimed',
      claimedByAgentId: agentId,
      claimedAt: sql`now()`,
    })
    .where(and(eq(tasks.id, id), eq(tasks.projectId, projectId), eq(tasks.status, 'pending')))
    .returning();
  return rows.length > 0;
}

export async function updateProgress(db: DrizzleDb, projectId: string, id: number, progress: string): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({
      status: 'in_progress',
      progressLog: sql`COALESCE(${tasks.progressLog}, '') || now()::text || ': ' || ${progress} || chr(10)`,
    })
    .where(and(eq(tasks.id, id), eq(tasks.projectId, projectId)))
    .returning();
  return rows.length > 0;
}

async function finalize(
  db: DrizzleDb,
  projectId: string,
  id: number,
  status: 'completed' | 'failed',
  result: unknown,
): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({
      status,
      completedAt: sql`now()`,
      result,
    })
    .where(
      and(
        eq(tasks.id, id),
        eq(tasks.projectId, projectId),
        inArray(tasks.status, [...ACTIVE_STATUSES]),
      ),
    )
    .returning();
  return rows.length > 0;
}

export async function complete(db: DrizzleDb, projectId: string, id: number, result: unknown): Promise<boolean> {
  return finalize(db, projectId, id, 'completed', result);
}

export async function fail(db: DrizzleDb, projectId: string, id: number, result: unknown): Promise<boolean> {
  return finalize(db, projectId, id, 'failed', result);
}

export async function release(db: DrizzleDb, projectId: string, id: number): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({
      status: 'pending',
      claimedByAgentId: null,
      claimedAt: null,
    })
    .where(
      and(
        eq(tasks.id, id),
        eq(tasks.projectId, projectId),
        inArray(tasks.status, [...ACTIVE_STATUSES]),
      ),
    )
    .returning();
  return rows.length > 0;
}

export async function reset(db: DrizzleDb, projectId: string, id: number): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({
      status: 'pending',
      claimedByAgentId: null,
      claimedAt: null,
      completedAt: null,
      result: null,
      progressLog: null,
    })
    .where(
      and(
        eq(tasks.id, id),
        eq(tasks.projectId, projectId),
        sql`${tasks.status} IN ('completed', 'failed', 'cycle')`,
      ),
    )
    .returning();
  return rows.length > 0;
}

export async function integrate(db: DrizzleDb, projectId: string, id: number): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({ status: 'integrated' })
    .where(and(eq(tasks.id, id), eq(tasks.projectId, projectId), eq(tasks.status, 'completed')))
    .returning();
  return rows.length > 0;
}

async function integrateWhere(
  db: DrizzleDb,
  projectId: string,
  extraConditions: SQL[],
): Promise<{ count: number; ids: number[] }> {
  return db.transaction(async (tx) => {
    const where = and(
      eq(tasks.projectId, projectId),
      eq(tasks.status, 'completed'),
      ...extraConditions,
    );

    const matching = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(where);

    const ids = matching.map((r) => r.id);
    if (ids.length === 0) return { count: 0, ids: [] };

    await tx
      .update(tasks)
      .set({ status: 'integrated' })
      .where(where);

    return { count: ids.length, ids };
  });
}

export async function integrateBatch(
  db: DrizzleDb,
  projectId: string,
  agentId: string,
): Promise<{ count: number; ids: number[] }> {
  return integrateWhere(db, projectId, [eq(tasks.claimedByAgentId, agentId)]);
}

export async function integrateAll(
  db: DrizzleDb,
  projectId: string,
): Promise<{ count: number; ids: number[] }> {
  return integrateWhere(db, projectId, []);
}

export async function releaseByAgent(db: DbOrTx, projectId: string, agentId: string): Promise<void> {
  await db
    .update(tasks)
    .set({
      status: 'pending',
      claimedByAgentId: null,
      claimedAt: null,
    })
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.claimedByAgentId, agentId),
        inArray(tasks.status, [...ACTIVE_STATUSES]),
      ),
    );
}

export async function releaseAllActive(db: DbOrTx, projectId: string): Promise<void> {
  await db
    .update(tasks)
    .set({
      status: 'pending',
      claimedByAgentId: null,
      claimedAt: null,
    })
    .where(
      and(
        eq(tasks.projectId, projectId),
        inArray(tasks.status, [...ACTIVE_STATUSES]),
      ),
    );
}

export async function getCompletedByAgent(db: DrizzleDb, projectId: string, agentId: string): Promise<TaskDbRow[]> {
  return db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.status, 'completed'),
        eq(tasks.claimedByAgentId, agentId),
      ),
    );
}

export async function getAllCompleted(db: DrizzleDb, projectId: string): Promise<TaskDbRow[]> {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, 'completed')));
}
