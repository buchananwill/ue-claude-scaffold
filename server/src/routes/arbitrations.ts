/**
 * Arbitration ingestion (Phase 7).
 *
 *   POST /tasks/:id/arbitrations — record an arbitrator ruling on a task in
 *                                  `arbitrating` and atomically drive the FSM
 *                                  transition out (`complete` / `revising` /
 *                                  `failed`) per the ruling.
 *
 * The arbitrator is the singleton tiebreaker for two FSM dead-ends:
 *   - `review_cycle_budget_exhausted` — task reached cycle 5 with an open
 *     request_changes verdict. Ruling: `approve` → complete, `escalate` → failed
 *     (`rule` is rejected for this trigger; cycle-budget arbitrations cannot
 *     synthesise a per-finding ruling).
 *   - `reviewer_contradiction` — engineer detected two findings that cannot
 *     both be satisfied. Ruling: `rule` → revising (with addendum path set
 *     so the next engineer cycle reads the upheld vs. retired finding),
 *     `approve` → complete, `escalate` → failed.
 *
 * The unique constraint `arbitration_runs_task_trigger_unique` enforces that
 * a task can be arbitrated at most once per trigger. A second POST for the
 * same `(taskId, trigger)` returns 409 — the operator must reset the task
 * to retry.
 */
import type { FastifyPluginAsync } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../drizzle-instance.js';
import { arbitrationRuns, tasks } from '../schema/tables.js';
import { requireProjectIdHeader } from './_project-id-guard.js';
import type { ScaffoldConfig } from '../config.js';

// Phase 7 cycle 1 (safety W2): accept `{ config }` at plugin registration so
// the arbitrations route exposes the same shape as other state-transition
// plugins that may need configuration (tasks, branchOps, syncPlugin). The
// route handler does not currently consume config fields, but the typed
// option surface matches the established pattern at the registration site in
// `server/src/index.ts`.
interface ArbitrationsOpts {
  config: ScaffoldConfig;
}

const ARBITRATION_TRIGGERS = [
  'review_cycle_budget_exhausted',
  'reviewer_contradiction',
] as const;
type ArbitrationTrigger = typeof ARBITRATION_TRIGGERS[number];

const RULINGS = ['approve', 'rule', 'escalate'] as const;
type Ruling = typeof RULINGS[number];

const RULING_MARKDOWN_MAX = 512_000;
const RATIONALE_MAX = 32_768;
const FAILURE_DETAIL_TRUNCATE = 500;

interface ContradictionResolutionInput {
  upheldFindingId: number;
  retiredFindingId: number;
  rationale: string;
}

interface PostArbitrationBody {
  trigger: ArbitrationTrigger;
  ruling: Ruling;
  rulingMarkdown: string;
  contradictionResolution?: ContradictionResolutionInput | null;
}

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

function isTrigger(v: unknown): v is ArbitrationTrigger {
  return typeof v === 'string' && (ARBITRATION_TRIGGERS as readonly string[]).includes(v);
}

function isRuling(v: unknown): v is Ruling {
  return typeof v === 'string' && (RULINGS as readonly string[]).includes(v);
}

function validateContradictionResolution(
  raw: unknown,
): ValidationResult<ContradictionResolutionInput> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'contradictionResolution must be an object' };
  }
  const o = raw as Record<string, unknown>;
  if (!Number.isInteger(o.upheldFindingId) || (o.upheldFindingId as number) <= 0) {
    return { ok: false, message: 'contradictionResolution.upheldFindingId must be a positive integer' };
  }
  if (!Number.isInteger(o.retiredFindingId) || (o.retiredFindingId as number) <= 0) {
    return { ok: false, message: 'contradictionResolution.retiredFindingId must be a positive integer' };
  }
  if (o.upheldFindingId === o.retiredFindingId) {
    return {
      ok: false,
      message: 'contradictionResolution.upheldFindingId and retiredFindingId must differ',
    };
  }
  if (typeof o.rationale !== 'string' || o.rationale.length === 0) {
    return { ok: false, message: 'contradictionResolution.rationale must be a non-empty string' };
  }
  if (o.rationale.length > RATIONALE_MAX) {
    return {
      ok: false,
      message: `contradictionResolution.rationale exceeds maximum length of ${RATIONALE_MAX}`,
    };
  }
  return {
    ok: true,
    value: {
      upheldFindingId: o.upheldFindingId as number,
      retiredFindingId: o.retiredFindingId as number,
      rationale: o.rationale,
    },
  };
}

function validateBody(raw: unknown): ValidationResult<PostArbitrationBody> {
  const body = (raw ?? {}) as Record<string, unknown>;

  if (!isTrigger(body.trigger)) {
    return {
      ok: false,
      message: `trigger must be one of: ${ARBITRATION_TRIGGERS.join(', ')}`,
    };
  }
  if (!isRuling(body.ruling)) {
    return {
      ok: false,
      message: `ruling must be one of: ${RULINGS.join(', ')}`,
    };
  }
  if (typeof body.rulingMarkdown !== 'string' || body.rulingMarkdown.length === 0) {
    return { ok: false, message: 'rulingMarkdown must be a non-empty string' };
  }
  if (body.rulingMarkdown.length > RULING_MARKDOWN_MAX) {
    return {
      ok: false,
      message: `rulingMarkdown exceeds maximum length of ${RULING_MARKDOWN_MAX}`,
    };
  }

  // Cross-field rules:
  //   - ruling = 'rule' is only legal for trigger = 'reviewer_contradiction'.
  //   - contradictionResolution MUST be present when ruling = 'rule'.
  //   - contradictionResolution MUST be absent otherwise (mirrors the
  //     `arbitration_runs_rule_resolution_check` DB CHECK).
  if (body.ruling === 'rule' && body.trigger !== 'reviewer_contradiction') {
    return {
      ok: false,
      message: "ruling 'rule' is only valid for trigger 'reviewer_contradiction'",
    };
  }

  const hasContradiction =
    body.contradictionResolution !== undefined && body.contradictionResolution !== null;

  if (body.ruling === 'rule') {
    if (!hasContradiction) {
      return {
        ok: false,
        message: 'contradictionResolution is required when ruling is \'rule\'',
      };
    }
    const cr = validateContradictionResolution(body.contradictionResolution);
    if (!cr.ok) return cr;
    return {
      ok: true,
      value: {
        trigger: body.trigger,
        ruling: body.ruling,
        rulingMarkdown: body.rulingMarkdown as string,
        contradictionResolution: cr.value,
      },
    };
  }

  // Non-rule rulings: contradictionResolution MUST be absent.
  if (hasContradiction) {
    return {
      ok: false,
      message: "contradictionResolution must be absent when ruling is not 'rule'",
    };
  }

  return {
    ok: true,
    value: {
      trigger: body.trigger,
      ruling: body.ruling,
      rulingMarkdown: body.rulingMarkdown as string,
      contradictionResolution: null,
    },
  };
}

/**
 * Detect whether an insert error corresponds to the unique violation on
 * `arbitration_runs_task_trigger_unique`. Both PG and PGlite surface unique
 * violations with SQLSTATE 23505; the constraint name may live in
 * `.constraint`, `.constraint_name`, or the error message text. Mirrors the
 * pattern in `reviews.ts:isUniqueRunConflict`.
 */
function isUniqueArbitrationConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown> & { cause?: unknown };
  const code = e.code;
  const message = typeof e.message === 'string' ? e.message : '';
  const constraint =
    (typeof e.constraint === 'string' && e.constraint)
    || (typeof e.constraint_name === 'string' && e.constraint_name)
    || '';
  const matchesConstraint =
    constraint === 'arbitration_runs_task_trigger_unique'
    || message.includes('arbitration_runs_task_trigger_unique');
  if (matchesConstraint) return true;
  if (e.cause) {
    return isUniqueArbitrationConflict(e.cause);
  }
  return code === '23505' && message.includes('arbitration_runs_task_trigger_unique');
}

/**
 * Build the column-write set the route applies to `tasks` alongside the FSM
 * status transition out of `arbitrating`. Mapping per ruling:
 *
 *   approve  → status='complete'   (clears arbitrationPendingTrigger,
 *                                   sets completedAt)
 *   rule     → status='revising'   (clears trigger, writes
 *                                   arbitrationAddendumPath pointing at the
 *                                   scratch ruling file the arbitrator session
 *                                   is expected to have produced; the next
 *                                   engineer cycle reads it via Phase 5
 *                                   branch 3)
 *   escalate → status='failed'     (clears trigger, sets failureReason=
 *                                   'arbitrator_escalated' and failureDetail
 *                                   to the first 500 chars of the ruling
 *                                   markdown, sets completedAt)
 *
 * The keys returned are valid columns on `tasks` (status,
 * arbitrationPendingTrigger, arbitrationAddendumPath, completedAt,
 * failureReason, failureDetail). The route splats this object into Drizzle's
 * `.set(...)` inside a `UPDATE tasks ... WHERE status = 'arbitrating'`
 * optimistic-lock write — if the task left `arbitrating` between the
 * pre-flight read and the transaction, the WHERE clause matches zero rows and
 * the route returns 409.
 */
type ArbitrationStatusUpdate = {
  status: 'complete' | 'revising' | 'failed';
  arbitrationPendingTrigger: null;
  arbitrationAddendumPath?: string;
  completedAt?: Date;
  failureReason?: string;
  failureDetail?: string;
};

function buildStatusUpdate(
  taskId: number,
  body: PostArbitrationBody,
): ArbitrationStatusUpdate {
  switch (body.ruling) {
    case 'approve':
      return {
        status: 'complete',
        arbitrationPendingTrigger: null,
        completedAt: new Date(),
      };
    case 'rule':
      return {
        status: 'revising',
        arbitrationPendingTrigger: null,
        arbitrationAddendumPath: `.scratch/arbitrations/${taskId}/contradiction-ruling.md`,
      };
    case 'escalate':
      return {
        status: 'failed',
        arbitrationPendingTrigger: null,
        failureReason: 'arbitrator_escalated',
        failureDetail: body.rulingMarkdown.slice(0, FAILURE_DETAIL_TRUNCATE),
        completedAt: new Date(),
      };
  }
}

const arbitrationsPlugin: FastifyPluginAsync<ArbitrationsOpts> = async (fastify) => {
  fastify.post<{
    Params: { id: string };
    Body: unknown;
  }>('/tasks/:id/arbitrations', async (request, reply) => {
    if (!requireProjectIdHeader(request, reply)) return;

    const taskId = Number(request.params.id);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return reply.badRequest('invalid task id');
    }

    const v = validateBody(request.body);
    if (!v.ok) return reply.badRequest(v.message);
    const body = v.value;

    const db = getDb();

    // Confirm the task exists in this project. We deliberately collapse
    // "not in this project" and "does not exist" into a single 404 to avoid
    // leaking cross-project existence.
    const taskRow = await db
      .select({ id: tasks.id, status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, request.projectId)))
      .limit(1);
    if (taskRow.length === 0) {
      return reply.notFound('task not found');
    }

    // The task must currently be in `arbitrating`. We re-check inside the
    // transaction below via applyTransition's expected-status gate; this is
    // a pre-flight that surfaces a clearer 409 before any DB work.
    if (taskRow[0].status !== 'arbitrating') {
      return reply.conflict(
        `task ${taskId} is not in 'arbitrating' (current: '${taskRow[0].status}')`,
      );
    }

    const statusUpdate = buildStatusUpdate(taskId, body);

    try {
      const result = await db.transaction(async (tx) => {
        // 1. Insert the arbitrationRuns row. Unique-constraint violation on
        //    (taskId, trigger) bubbles out of the transaction; we catch and
        //    map to 409 below.
        const inserted = await tx
          .insert(arbitrationRuns)
          .values({
            taskId,
            trigger: body.trigger,
            ruling: body.ruling,
            rulingMarkdown: body.rulingMarkdown,
            contradictionResolution: body.contradictionResolution ?? null,
          })
          .returning();
        const runId = inserted[0]!.id;

        // 2. Apply the FSM transition. The WHERE clause includes
        //    `status = 'arbitrating'` as an optimistic-lock gate; if the
        //    task left arbitrating between the pre-flight read and now
        //    (concurrent operator reset, crash recovery), the UPDATE
        //    matches zero rows and we 409 by throwing the sentinel error
        //    below (which rolls back the arbitrationRuns insert).
        const updatedTask = await tx
          .update(tasks)
          .set(statusUpdate)
          .where(
            and(
              eq(tasks.id, taskId),
              eq(tasks.projectId, request.projectId),
              eq(tasks.status, 'arbitrating'),
            ),
          )
          .returning();

        if (updatedTask.length === 0) {
          // Drizzle rolls back the transaction when we throw.
          throw new Error('TASK_STATE_CHANGED');
        }

        return { runId, newStatus: updatedTask[0].status };
      });

      return result;
    } catch (err) {
      if (isUniqueArbitrationConflict(err)) {
        return reply.conflict(
          `arbitration run already exists for task ${taskId}, trigger '${body.trigger}'`,
        );
      }
      if (err instanceof Error && err.message === 'TASK_STATE_CHANGED') {
        return reply.conflict(
          `task ${taskId} status changed concurrently; expected 'arbitrating'`,
        );
      }
      throw err;
    }
  });
};

export default arbitrationsPlugin;
