import { eq, and, sql, inArray, type SQL } from "drizzle-orm";
import {
  tasks,
  arbitrationRuns,
  reviewRuns,
  reviewFindings,
} from "../schema/tables.js";
import type { DrizzleDb, DbOrTx } from "../drizzle-instance.js";
import type { TaskDbRow } from "./tasks-core.js";
import type { ReviewerAggregate } from "../review-decision.js";
import { ACTIVE_STATUSES } from "./query-helpers.js";

export async function claim(
  db: DrizzleDb,
  projectId: string,
  id: number,
  agentId: string,
): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({
      status: "claimed",
      claimedByAgentId: agentId,
      claimedAt: sql`now()`,
    })
    .where(
      and(
        eq(tasks.id, id),
        eq(tasks.projectId, projectId),
        eq(tasks.status, "pending"),
      ),
    )
    .returning();
  return rows.length > 0;
}

export async function updateProgress(
  db: DrizzleDb,
  projectId: string,
  id: number,
  progress: string,
): Promise<boolean> {
  // Append a timestamped line to progress_log without touching status.
  // Pre-FSM this helper transitioned 'claimed' -> 'in_progress' as a side
  // effect; under the FSM, role sessions own their own status transitions and
  // the legacy 'in_progress' value is no longer in the schema CHECK. The WHERE
  // clause restricts updates to tasks actively held by an agent (claimed or
  // any FSM mid-state) so a no-op caller still sees the conflict response.
  const rows = await db
    .update(tasks)
    .set({
      progressLog: sql`COALESCE(${tasks.progressLog}, '') || now()::text || ': ' || ${progress} || chr(10)`,
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

/**
 * Release a task: revert a `claimed` task to `pending` and clear its claim
 * metadata so another agent can pick it up.
 *
 * FSM mid-state tasks (`engineering`, `built`, `reviewing`, `revising`,
 * `arbitrating`) are deliberately untouched. Under the durable-task FSM, the
 * work record lives on the claiming agent's git branch — only that same
 * `claimedByAgentId` UUID can resume mid-state work (via the startup probe in
 * `pump-loop.sh:_resume_in_flight_tasks`). A fire-and-forget release on
 * container shutdown or abnormal exit therefore intentionally leaves the
 * claim attached so the next restart of the same agent slot picks the task
 * back up at its current FSM state. Permanent abandonment of mid-state work
 * is an explicit operator action, not an automatic consequence of process
 * exit.
 *
 * Returns true iff a row was actually reverted (`claimed` → `pending`).
 * Returns false for FSM mid-state, terminal, or unknown tasks — the caller
 * treats false as "nothing to do" rather than an error.
 */
export async function release(
  db: DrizzleDb,
  projectId: string,
  id: number,
): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({
      status: "pending",
      claimedByAgentId: null,
      claimedAt: null,
    })
    .where(
      and(
        eq(tasks.id, id),
        eq(tasks.projectId, projectId),
        eq(tasks.status, "claimed"),
      ),
    )
    .returning();
  return rows.length > 0;
}

/** Statuses from which an operator-initiated reset back to 'pending' is allowed. */
const RESETTABLE_STATUSES = ["completed", "failed", "cycle"] as const;

export async function reset(
  db: DrizzleDb,
  projectId: string,
  id: number,
): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({
      status: "pending",
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

export async function integrate(
  db: DrizzleDb,
  projectId: string,
  id: number,
): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({ status: "integrated" })
    .where(
      and(
        eq(tasks.id, id),
        eq(tasks.projectId, projectId),
        eq(tasks.status, "completed"),
      ),
    )
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
      eq(tasks.status, "completed"),
      ...extraConditions,
    );

    const matching = await tx.select({ id: tasks.id }).from(tasks).where(where);

    const ids = matching.map((r) => r.id);
    if (ids.length === 0) return { count: 0, ids: [] };

    await tx.update(tasks).set({ status: "integrated" }).where(where);

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

/**
 * Bulk-release every `claimed` task held by `agentId`. Mirrors the
 * `release()` contract: FSM mid-state tasks (`engineering`, `built`,
 * `reviewing`, `revising`, `arbitrating`) are intentionally left attached
 * to the agent because the work record lives on that agent's git branch.
 * The agent slot's UUID survives soft-delete and is restored on the next
 * `register()` upsert, so an operator who later re-launches the same slot
 * resumes the mid-state work via `_resume_in_flight_tasks`. Permanent
 * abandonment is an explicit operator action, not implicit in the
 * agent-delete flow.
 */
export async function releaseByAgent(
  db: DbOrTx,
  projectId: string,
  agentId: string,
): Promise<void> {
  await db
    .update(tasks)
    .set({
      status: "pending",
      claimedByAgentId: null,
      claimedAt: null,
    })
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.claimedByAgentId, agentId),
        eq(tasks.status, "claimed"),
      ),
    );
}

/**
 * Bulk-release every `claimed` task for the project. Same FSM-mid-state
 * preservation rule as `release()` / `releaseByAgent()` — see those docs.
 */
export async function releaseAllActive(
  db: DbOrTx,
  projectId: string,
): Promise<void> {
  await db
    .update(tasks)
    .set({
      status: "pending",
      claimedByAgentId: null,
      claimedAt: null,
    })
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, "claimed")));
}

export async function getCompletedByAgent(
  db: DrizzleDb,
  projectId: string,
  agentId: string,
): Promise<TaskDbRow[]> {
  return db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.status, "completed"),
        eq(tasks.claimedByAgentId, agentId),
      ),
    );
}

export async function getAllCompleted(
  db: DrizzleDb,
  projectId: string,
): Promise<TaskDbRow[]> {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, "completed")));
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
  if (update.reviewerVerdicts !== undefined)
    set.reviewerVerdicts = update.reviewerVerdicts;
  if (update.arbitrationPendingTrigger !== undefined) {
    set.arbitrationPendingTrigger = update.arbitrationPendingTrigger;
  }
  if (update.failureReason !== undefined)
    set.failureReason = update.failureReason;
  if (update.failureDetail !== undefined)
    set.failureDetail = update.failureDetail;
  if (update.reviewCycleCount !== undefined)
    set.reviewCycleCount = update.reviewCycleCount;
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
    .where(
      and(
        eq(arbitrationRuns.taskId, taskId),
        eq(arbitrationRuns.trigger, trigger),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Per-reviewer roll-up of one review cycle: each reviewer's verdict plus its
 * total and BLOCKING finding tallies. Feeds `classifyReview` (review-decision.ts)
 * to gate the `reviewing → completed` / `reviewing → revising` transitions.
 *
 * Uses a LEFT JOIN so a reviewer with zero findings still produces a row;
 * `count(reviewFindings.id)` is null-safe (counts only matched finding rows),
 * so a no-findings reviewer reports findingsCount = 0 rather than 1.
 */
export async function getReviewerAggregates(
  db: DrizzleDb,
  taskId: number,
  cycle: number,
): Promise<ReviewerAggregate[]> {
  const rows = await db
    .select({
      reviewerRole: reviewRuns.reviewerRole,
      verdict: reviewRuns.verdict,
      findingsCount: sql<number>`count(${reviewFindings.id})`,
      blockingCount: sql<number>`count(${reviewFindings.id}) filter (where ${reviewFindings.severity} = 'BLOCKING')`,
    })
    .from(reviewRuns)
    .leftJoin(reviewFindings, eq(reviewFindings.runId, reviewRuns.id))
    .where(and(eq(reviewRuns.taskId, taskId), eq(reviewRuns.cycle, cycle)))
    .groupBy(reviewRuns.id, reviewRuns.reviewerRole, reviewRuns.verdict);

  // pg/PGlite return bigint aggregates as strings — normalise to number.
  return rows.map((r) => ({
    reviewerRole: r.reviewerRole,
    verdict: r.verdict,
    findingsCount: Number(r.findingsCount),
    blockingCount: Number(r.blockingCount),
  }));
}
