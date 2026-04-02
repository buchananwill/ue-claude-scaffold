import { eq, and, sql } from 'drizzle-orm';
import { tasks } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

export async function claim(db: DrizzleDb, id: number, agent: string): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({
      status: 'claimed',
      claimedBy: agent,
      claimedAt: sql`now()`,
    })
    .where(and(eq(tasks.id, id), eq(tasks.status, 'pending')))
    .returning();
  return rows.length > 0;
}

export async function updateProgress(db: DrizzleDb, id: number, progress: string): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({
      status: 'in_progress',
      progressLog: sql`COALESCE(${tasks.progressLog}, '') || now()::text || ': ' || ${progress} || chr(10)`,
    })
    .where(eq(tasks.id, id))
    .returning();
  return rows.length > 0;
}

export async function complete(db: DrizzleDb, id: number, result: unknown): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({
      status: 'completed',
      completedAt: sql`now()`,
      result,
    })
    .where(
      and(
        eq(tasks.id, id),
        sql`${tasks.status} IN ('claimed', 'in_progress')`,
      ),
    )
    .returning();
  return rows.length > 0;
}

export async function fail(db: DrizzleDb, id: number, result: unknown): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({
      status: 'failed',
      completedAt: sql`now()`,
      result,
    })
    .where(
      and(
        eq(tasks.id, id),
        sql`${tasks.status} IN ('claimed', 'in_progress')`,
      ),
    )
    .returning();
  return rows.length > 0;
}

export async function release(db: DrizzleDb, id: number): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({
      status: 'pending',
      claimedBy: null,
      claimedAt: null,
    })
    .where(
      and(
        eq(tasks.id, id),
        sql`${tasks.status} IN ('claimed', 'in_progress')`,
      ),
    )
    .returning();
  return rows.length > 0;
}

export async function reset(db: DrizzleDb, id: number): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({
      status: 'pending',
      claimedBy: null,
      claimedAt: null,
      completedAt: null,
      result: null,
      progressLog: null,
    })
    .where(
      and(
        eq(tasks.id, id),
        sql`${tasks.status} IN ('completed', 'failed', 'cycle')`,
      ),
    )
    .returning();
  return rows.length > 0;
}

export async function integrate(db: DrizzleDb, id: number): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({ status: 'integrated' })
    .where(and(eq(tasks.id, id), eq(tasks.status, 'completed')))
    .returning();
  return rows.length > 0;
}

export async function integrateBatch(
  db: DrizzleDb,
  agent: string,
): Promise<{ count: number; ids: number[] }> {
  // Use a transaction: select matching IDs, then update them
  const result = await db.transaction(async (tx) => {
    const matching = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, 'completed'),
          sql`${tasks.result}->>'agent' = ${agent}`,
        ),
      );

    const ids = matching.map((r) => r.id);
    if (ids.length === 0) return { count: 0, ids: [] };

    await tx
      .update(tasks)
      .set({ status: 'integrated' })
      .where(
        and(
          eq(tasks.status, 'completed'),
          sql`${tasks.result}->>'agent' = ${agent}`,
        ),
      );

    return { count: ids.length, ids };
  });

  return result;
}

export async function integrateAll(
  db: DrizzleDb,
): Promise<{ count: number; ids: number[] }> {
  const result = await db.transaction(async (tx) => {
    const matching = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.status, 'completed'));

    const ids = matching.map((r) => r.id);
    if (ids.length === 0) return { count: 0, ids: [] };

    await tx
      .update(tasks)
      .set({ status: 'integrated' })
      .where(eq(tasks.status, 'completed'));

    return { count: ids.length, ids };
  });

  return result;
}

export async function releaseByAgent(db: DrizzleDb, agent: string) {
  await db
    .update(tasks)
    .set({
      status: 'pending',
      claimedBy: null,
      claimedAt: null,
    })
    .where(
      and(
        eq(tasks.claimedBy, agent),
        sql`${tasks.status} IN ('claimed', 'in_progress')`,
      ),
    );
}

export async function releaseAllActive(db: DrizzleDb) {
  await db
    .update(tasks)
    .set({
      status: 'pending',
      claimedBy: null,
      claimedAt: null,
    })
    .where(sql`${tasks.status} IN ('claimed', 'in_progress')`);
}

export async function getCompletedByAgent(db: DrizzleDb, agent: string) {
  return db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'completed'),
        sql`${tasks.result}->>'agent' = ${agent}`,
      ),
    );
}

export async function getAllCompleted(db: DrizzleDb) {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.status, 'completed'));
}
