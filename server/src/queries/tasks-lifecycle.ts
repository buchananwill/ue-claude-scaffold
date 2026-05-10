import { eq, and, sql, inArray, type SQL } from 'drizzle-orm';
import { tasks, arbitrationRuns } from '../schema/tables.js';
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
    .where(and(eq(tasks.id, id), eq(tasks.projectId, projectId), inArray(tasks.status, [...ACTIVE_STATUSES])))
    .returning();
  return rows.length > 0;
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

/** Statuses from which an operator-initiated reset back to 'pending' is allowed. */
const RESETTABLE_STATUSES = ['complete', 'failed', 'cycle'] as const;

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
        inArray(tasks.status, [...RESETTABLE_STATUSES]),
      ),
    )
    .returning();
  return rows.length > 0;
}

export async function integrate(db: DrizzleDb, projectId: string, id: number): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({ status: 'integrated' })
    .where(and(eq(tasks.id, id), eq(tasks.projectId, projectId), eq(tasks.status, 'complete')))
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
      eq(tasks.status, 'complete'),
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
        eq(tasks.status, 'complete'),
        eq(tasks.claimedByAgentId, agentId),
      ),
    );
}

export async function getAllCompleted(db: DrizzleDb, projectId: string): Promise<TaskDbRow[]> {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, 'complete')));
}

// ── FSM transition support ────────────────────────────────────────────

/**
 * Set of fields that can be updated atomically alongside a status transition.
 * The route layer assembles this object based on payload + transition rules
 * (e.g. `reviewerVerdicts` reset on built→reviewing, single-key merge on
 * reviewing→reviewing, arbitration trigger set/clear, etc.) and passes it
 * here verbatim. This module performs the database write only — it does not
 * re-derive the transition logic.
 */
export interface TransitionUpdate {
  status: string;
  buildStatus?: string;
  commitSha?: string;
  latestReviewPath?: string;
  reviewerVerdicts?: Record<string, string>;
  arbitrationPendingTrigger?: string | null;
  failureReason?: string;
  failureDetail?: string;
  reviewCycleCount?: number;
  completedAt?: Date | null;
}

/**
 * Atomically transition a task's status (with any per-payload column updates)
 * gated on the task currently being in `expectedStatus`. Returns the updated
 * row, or null if no row matched (caller maps to 409).
 */
export async function applyTransition(
  db: DrizzleDb,
  projectId: string,
  id: number,
  expectedStatus: string,
  update: TransitionUpdate,
): Promise<TaskDbRow | null> {
  const set: Record<string, unknown> = { status: update.status };
  if (update.buildStatus !== undefined) set.buildStatus = update.buildStatus;
  if (update.commitSha !== undefined) set.commitSha = update.commitSha;
  if (update.latestReviewPath !== undefined) set.latestReviewPath = update.latestReviewPath;
  if (update.reviewerVerdicts !== undefined) set.reviewerVerdicts = update.reviewerVerdicts;
  if (update.arbitrationPendingTrigger !== undefined) {
    set.arbitrationPendingTrigger = update.arbitrationPendingTrigger;
  }
  if (update.failureReason !== undefined) set.failureReason = update.failureReason;
  if (update.failureDetail !== undefined) set.failureDetail = update.failureDetail;
  if (update.reviewCycleCount !== undefined) set.reviewCycleCount = update.reviewCycleCount;
  if (update.completedAt !== undefined) set.completedAt = update.completedAt;

  const rows = await db
    .update(tasks)
    .set(set)
    .where(
      and(
        eq(tasks.id, id),
        eq(tasks.projectId, projectId),
        eq(tasks.status, expectedStatus),
      ),
    )
    .returning();

  return rows[0] ?? null;
}

/**
 * True if an `arbitrationRuns` row already exists for `(taskId, trigger)`.
 * Used to enforce arbitration uniqueness — a task cannot be arbitrated twice
 * for the same trigger (the operator must reset instead).
 */
export async function arbitrationExists(
  db: DrizzleDb,
  taskId: number,
  trigger: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: arbitrationRuns.id })
    .from(arbitrationRuns)
    .where(and(eq(arbitrationRuns.taskId, taskId), eq(arbitrationRuns.trigger, trigger)))
    .limit(1);
  return rows.length > 0;
}
