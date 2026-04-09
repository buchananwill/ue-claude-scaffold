import { eq, and, desc, asc, ne, sql, count as countFn } from 'drizzle-orm';
import { ubtLock, ubtQueue, agents } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

export async function getLock(db: DrizzleDb, hostId: string = 'local') {
  const rows = await db
    .select()
    .from(ubtLock)
    .where(eq(ubtLock.hostId, hostId));
  return rows[0] ?? null;
}

export async function acquireLock(
  db: DrizzleDb,
  agentId: string,
  priority: number,
  hostId: string = 'local',
) {
  await db
    .insert(ubtLock)
    .values({
      hostId,
      holderAgentId: agentId,
      acquiredAt: sql`now()`,
      priority,
    })
    .onConflictDoUpdate({
      target: ubtLock.hostId,
      set: {
        holderAgentId: agentId,
        acquiredAt: sql`now()`,
        priority,
      },
    });
}

export async function releaseLock(db: DrizzleDb, hostId: string = 'local') {
  await db.delete(ubtLock).where(eq(ubtLock.hostId, hostId));
}

export async function enqueue(
  db: DrizzleDb,
  agentId: string,
  priority: number,
): Promise<number> {
  const rows = await db
    .insert(ubtQueue)
    .values({ agentId, priority })
    .returning();
  return rows[0].id;
}

export async function dequeue(db: DrizzleDb) {
  // Atomic delete+return via subquery — avoids TOCTOU race under concurrent access
  const rows = await db.execute<{
    id: number;
    agent_id: string;
    priority: number;
    requested_at: Date;
  }>(sql`
    DELETE FROM ubt_queue
    WHERE id = (
      SELECT id FROM ubt_queue
      ORDER BY priority DESC, id ASC
      LIMIT 1
    )
    RETURNING *
  `);
  return rows.rows[0] ?? null;
}

export async function getQueue(db: DrizzleDb) {
  return db
    .select()
    .from(ubtQueue)
    .orderBy(desc(ubtQueue.priority), asc(ubtQueue.id));
}

export async function getQueuePosition(
  db: DrizzleDb,
  id: number,
  priority: number,
): Promise<number> {
  const rows = await db
    .select({ count: countFn() })
    .from(ubtQueue)
    .where(
      sql`(${ubtQueue.priority} > ${priority} OR (${ubtQueue.priority} = ${priority} AND ${ubtQueue.id} <= ${id}))`,
    );
  return Number(rows[0].count);
}

export async function findInQueue(db: DrizzleDb, agentId: string) {
  const rows = await db
    .select({ id: ubtQueue.id, priority: ubtQueue.priority })
    .from(ubtQueue)
    .where(eq(ubtQueue.agentId, agentId));
  return rows[0] ?? null;
}

export async function isAgentRegistered(db: DrizzleDb, agentId: string): Promise<boolean> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), ne(agents.status, 'stopping')));
  return rows.length > 0;
}
