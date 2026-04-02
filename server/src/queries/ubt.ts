import { eq, and, gt, desc, asc, ne, sql, count as countFn } from 'drizzle-orm';
import { ubtLock, ubtQueue, agents } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

export async function getLock(db: DrizzleDb, projectId: string = 'default') {
  const rows = await db
    .select()
    .from(ubtLock)
    .where(eq(ubtLock.projectId, projectId));
  return rows[0] ?? null;
}

export async function acquireLock(
  db: DrizzleDb,
  holder: string,
  priority: number,
  projectId: string = 'default',
) {
  await db
    .insert(ubtLock)
    .values({
      projectId,
      holder,
      acquiredAt: sql`now()`,
      priority,
    })
    .onConflictDoUpdate({
      target: ubtLock.projectId,
      set: {
        holder,
        acquiredAt: sql`now()`,
        priority,
      },
    });
}

export async function releaseLock(db: DrizzleDb, projectId: string = 'default') {
  await db.delete(ubtLock).where(eq(ubtLock.projectId, projectId));
}

export async function enqueue(
  db: DrizzleDb,
  agent: string,
  priority: number,
  projectId: string = 'default',
): Promise<number> {
  const rows = await db
    .insert(ubtQueue)
    .values({ agent, priority, projectId })
    .returning();
  return rows[0].id;
}

export async function dequeue(db: DrizzleDb, projectId: string = 'default') {
  // Atomic delete+return via subquery — avoids TOCTOU race under concurrent access
  const rows = await db.execute<{
    id: number;
    project_id: string;
    agent: string;
    priority: number;
    requested_at: Date;
  }>(sql`
    DELETE FROM ubt_queue
    WHERE id = (
      SELECT id FROM ubt_queue
      WHERE project_id = ${projectId}
      ORDER BY priority DESC, id ASC
      LIMIT 1
    )
    RETURNING *
  `);
  return rows.rows[0] ?? null;
}

export async function getQueue(db: DrizzleDb, projectId: string = 'default') {
  return db
    .select()
    .from(ubtQueue)
    .where(eq(ubtQueue.projectId, projectId))
    .orderBy(desc(ubtQueue.priority), asc(ubtQueue.id));
}

export async function getQueuePosition(
  db: DrizzleDb,
  id: number,
  priority: number,
): Promise<number> {
  // Count entries that are ahead: higher priority, or same priority with lower/equal id
  const rows = await db
    .select({ count: countFn() })
    .from(ubtQueue)
    .where(
      sql`(${ubtQueue.priority} > ${priority} OR (${ubtQueue.priority} = ${priority} AND ${ubtQueue.id} <= ${id}))`,
    );
  return Number(rows[0].count);
}

export async function findInQueue(db: DrizzleDb, agent: string, projectId: string = 'default') {
  const rows = await db
    .select({ id: ubtQueue.id, priority: ubtQueue.priority })
    .from(ubtQueue)
    .where(and(eq(ubtQueue.agent, agent), eq(ubtQueue.projectId, projectId)));
  return rows[0] ?? null;
}

export async function isAgentRegistered(db: DrizzleDb, holder: string): Promise<boolean> {
  const rows = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.name, holder), ne(agents.status, 'stopping')));
  return rows.length > 0;
}
