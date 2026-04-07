import { eq, and, sql, isNotNull, count as countFn, inArray } from 'drizzle-orm';
import { tasks, files, agents } from '../schema/tables.js';
import type { DrizzleDb, DrizzleTx } from '../drizzle-instance.js';

type DbOrTx = DrizzleDb | DrizzleTx;

const ACTIVE_STATUSES = ['claimed', 'in_progress'];

export async function countActiveTasks(db: DrizzleDb, projectId?: string): Promise<number> {
  const conditions = [sql`${tasks.status} IN ('claimed', 'in_progress')`];
  if (projectId) {
    conditions.push(eq(tasks.projectId, projectId));
  }
  const rows = await db
    .select({ count: countFn() })
    .from(tasks)
    .where(and(...conditions));
  return Number(rows[0].count);
}

export async function countActiveTasksForAgent(db: DrizzleDb, agent: string): Promise<number> {
  const rows = await db
    .select({ count: countFn() })
    .from(tasks)
    .where(
      and(
        eq(tasks.claimedBy, agent),
        sql`${tasks.status} IN ('claimed', 'in_progress')`,
      ),
    );
  return Number(rows[0].count);
}

export async function countPendingTasks(db: DrizzleDb, projectId?: string): Promise<number> {
  const conditions = [eq(tasks.status, 'pending')];
  if (projectId) {
    conditions.push(eq(tasks.projectId, projectId));
  }
  const rows = await db
    .select({ count: countFn() })
    .from(tasks)
    .where(and(...conditions));
  return Number(rows[0].count);
}

export async function countClaimedFiles(db: DbOrTx, projectId?: string): Promise<number> {
  const conditions = [isNotNull(files.claimant)];
  if (projectId) {
    conditions.push(eq(files.projectId, projectId));
  }
  const rows = await db
    .select({ count: countFn() })
    .from(files)
    .where(and(...conditions));
  return Number(rows[0].count);
}

export async function getOwnedFiles(db: DrizzleDb, agent: string, projectId?: string) {
  const conditions = [eq(files.claimant, agent)];
  if (projectId) {
    conditions.push(eq(files.projectId, projectId));
  }
  const rows = await db
    .select({ path: files.path })
    .from(files)
    .where(and(...conditions));
  return rows.map((r) => r.path);
}

export async function pausePumpAgents(db: DrizzleDb, projectId?: string) {
  const conditions = [
    eq(agents.mode, 'pump'),
    sql`${agents.status} NOT IN ('stopping', 'done', 'error', 'paused')`,
  ];
  if (projectId) {
    conditions.push(eq(agents.projectId, projectId));
  }
  await db
    .update(agents)
    .set({ status: 'paused' })
    .where(and(...conditions));
}

export async function getInFlightTasks(db: DrizzleDb, projectId?: string) {
  const conditions = [sql`${tasks.status} IN ('claimed', 'in_progress')`];
  if (projectId) {
    conditions.push(eq(tasks.projectId, projectId));
  }
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      claimedBy: tasks.claimedBy,
    })
    .from(tasks)
    .where(and(...conditions));
}

export async function releaseAllFiles(db: DbOrTx, projectId?: string) {
  const conditions = [isNotNull(files.claimant)];
  if (projectId) {
    conditions.push(eq(files.projectId, projectId));
  }
  await db
    .update(files)
    .set({ claimant: null, claimedAt: null })
    .where(and(...conditions));
}

export async function resumePausedAgents(db: DbOrTx, projectId?: string) {
  const conditions = [eq(agents.status, 'paused')];
  if (projectId) {
    conditions.push(eq(agents.projectId, projectId));
  }
  await db
    .update(agents)
    .set({ status: 'idle' })
    .where(and(...conditions));
}

export async function getPausedAgentNames(db: DbOrTx, projectId?: string): Promise<string[]> {
  const conditions = [eq(agents.status, 'paused')];
  if (projectId) {
    conditions.push(eq(agents.projectId, projectId));
  }
  const rows = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(...conditions));
  return rows.map((r) => r.name);
}
