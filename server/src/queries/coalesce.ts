import { eq, and, sql, isNotNull, count as countFn, inArray } from 'drizzle-orm';
import { tasks, files, agents } from '../schema/tables.js';
import type { DrizzleDb, DrizzleTx } from '../drizzle-instance.js';

type DbOrTx = DrizzleDb | DrizzleTx;

const ACTIVE_STATUSES = ['claimed', 'in_progress'] as const;

export async function countActiveTasks(db: DrizzleDb, projectId: string): Promise<number> {
  const rows = await db
    .select({ count: countFn() })
    .from(tasks)
    .where(and(inArray(tasks.status, ACTIVE_STATUSES), eq(tasks.projectId, projectId)));
  return Number(rows[0].count);
}

export async function countActiveTasksForAgent(db: DrizzleDb, projectId: string, agentId: string): Promise<number> {
  const rows = await db
    .select({ count: countFn() })
    .from(tasks)
    .where(
      and(
        eq(tasks.claimedByAgentId, agentId),
        inArray(tasks.status, ACTIVE_STATUSES),
        eq(tasks.projectId, projectId),
      ),
    );
  return Number(rows[0].count);
}

export async function countPendingTasks(db: DrizzleDb, projectId: string): Promise<number> {
  const rows = await db
    .select({ count: countFn() })
    .from(tasks)
    .where(and(eq(tasks.status, 'pending'), eq(tasks.projectId, projectId)));
  return Number(rows[0].count);
}

export async function countClaimedFiles(db: DbOrTx, projectId: string): Promise<number> {
  const rows = await db
    .select({ count: countFn() })
    .from(files)
    .where(and(isNotNull(files.claimantAgentId), eq(files.projectId, projectId)));
  return Number(rows[0].count);
}

export async function getOwnedFiles(db: DrizzleDb, projectId: string, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ path: files.path })
    .from(files)
    .where(and(eq(files.claimantAgentId, agentId), eq(files.projectId, projectId)));
  return rows.map((r) => r.path);
}

export async function pausePumpAgents(db: DrizzleDb, projectId: string): Promise<void> {
  await db
    .update(agents)
    .set({ status: 'paused' })
    .where(
      and(
        eq(agents.mode, 'pump'),
        eq(agents.projectId, projectId),
        sql`${agents.status} NOT IN ('stopping', 'done', 'error', 'paused')`,
      ),
    );
}

export async function getInFlightTasks(db: DrizzleDb, projectId: string): Promise<Array<{ id: number; title: string; claimedByAgentId: string | null }>> {
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      claimedByAgentId: tasks.claimedByAgentId,
    })
    .from(tasks)
    .where(and(inArray(tasks.status, ACTIVE_STATUSES), eq(tasks.projectId, projectId)));
}

export async function releaseAllFiles(db: DbOrTx, projectId: string): Promise<void> {
  await db
    .update(files)
    .set({ claimantAgentId: null, claimedAt: null })
    .where(and(isNotNull(files.claimantAgentId), eq(files.projectId, projectId)));
}

export async function resumePausedAgents(db: DbOrTx, projectId: string): Promise<void> {
  await db
    .update(agents)
    .set({ status: 'idle' })
    .where(and(eq(agents.status, 'paused'), eq(agents.projectId, projectId)));
}

export async function getPausedAgentNames(db: DbOrTx, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.status, 'paused'), eq(agents.projectId, projectId)));
  return rows.map((r) => r.name);
}
