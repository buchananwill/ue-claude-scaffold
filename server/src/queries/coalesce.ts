import { eq, and, sql, isNotNull, count as countFn, inArray } from 'drizzle-orm';
import { tasks, files, agents } from '../schema/tables.js';
import type { DrizzleDb, DrizzleTx } from '../drizzle-instance.js';

type DbOrTx = DrizzleDb | DrizzleTx;

const ACTIVE_STATUSES = ['claimed', 'in_progress'] as const;

export async function countActiveTasks(db: DrizzleDb, projectId?: string): Promise<number> {
  const baseCond = inArray(tasks.status, ACTIVE_STATUSES);
  const rows = await db
    .select({ count: countFn() })
    .from(tasks)
    .where(projectId ? and(baseCond, eq(tasks.projectId, projectId)) : baseCond);
  return Number(rows[0].count);
}

export async function countActiveTasksForAgent(db: DrizzleDb, agent: string, projectId?: string): Promise<number> {
  const baseCond = and(
    eq(tasks.claimedBy, agent),
    inArray(tasks.status, ACTIVE_STATUSES),
  );
  const rows = await db
    .select({ count: countFn() })
    .from(tasks)
    .where(projectId ? and(baseCond, eq(tasks.projectId, projectId)) : baseCond);
  return Number(rows[0].count);
}

export async function countPendingTasks(db: DrizzleDb, projectId?: string): Promise<number> {
  const baseCond = eq(tasks.status, 'pending');
  const rows = await db
    .select({ count: countFn() })
    .from(tasks)
    .where(projectId ? and(baseCond, eq(tasks.projectId, projectId)) : baseCond);
  return Number(rows[0].count);
}

export async function countClaimedFiles(db: DbOrTx, projectId?: string): Promise<number> {
  const baseCond = isNotNull(files.claimant);
  const rows = await db
    .select({ count: countFn() })
    .from(files)
    .where(projectId ? and(baseCond, eq(files.projectId, projectId)) : baseCond);
  return Number(rows[0].count);
}

export async function getOwnedFiles(db: DrizzleDb, agent: string, projectId?: string): Promise<string[]> {
  const baseCond = eq(files.claimant, agent);
  const rows = await db
    .select({ path: files.path })
    .from(files)
    .where(projectId ? and(baseCond, eq(files.projectId, projectId)) : baseCond);
  return rows.map((r) => r.path);
}

export async function pausePumpAgents(db: DrizzleDb, projectId?: string): Promise<void> {
  const baseCond = and(
    eq(agents.mode, 'pump'),
    sql`${agents.status} NOT IN ('stopping', 'done', 'error', 'paused')`,
  );
  await db
    .update(agents)
    .set({ status: 'paused' })
    .where(projectId ? and(baseCond, eq(agents.projectId, projectId)) : baseCond);
}

export async function getInFlightTasks(db: DrizzleDb, projectId?: string): Promise<Array<{ id: number; title: string; claimedBy: string | null }>> {
  const baseCond = inArray(tasks.status, ACTIVE_STATUSES);
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      claimedBy: tasks.claimedBy,
    })
    .from(tasks)
    .where(projectId ? and(baseCond, eq(tasks.projectId, projectId)) : baseCond);
}

export async function releaseAllFiles(db: DbOrTx, projectId?: string): Promise<void> {
  const baseCond = isNotNull(files.claimant);
  await db
    .update(files)
    .set({ claimant: null, claimedAt: null })
    .where(projectId ? and(baseCond, eq(files.projectId, projectId)) : baseCond);
}

export async function resumePausedAgents(db: DbOrTx, projectId?: string): Promise<void> {
  const baseCond = eq(agents.status, 'paused');
  await db
    .update(agents)
    .set({ status: 'idle' })
    .where(projectId ? and(baseCond, eq(agents.projectId, projectId)) : baseCond);
}

export async function getPausedAgentNames(db: DbOrTx, projectId?: string): Promise<string[]> {
  const baseCond = eq(agents.status, 'paused');
  const rows = await db
    .select({ name: agents.name })
    .from(agents)
    .where(projectId ? and(baseCond, eq(agents.projectId, projectId)) : baseCond);
  return rows.map((r) => r.name);
}
