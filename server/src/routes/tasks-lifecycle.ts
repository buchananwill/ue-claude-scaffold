import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as tasksCore from '../queries/tasks-core.js';
import * as tasksLifecycleQ from '../queries/tasks-lifecycle.js';
import { existsInBareRepo, isCommittedInRepo } from '../git-utils.js';
import { seedBranchFor, AGENT_NAME_RE } from '../branch-naming.js';
import { resolveProject } from '../resolve-project.js';
import type { TasksOpts } from './tasks-files.js';
import { resolveAgent } from './route-helpers.js';

// ── FSM definitions ───────────────────────────────────────────────────────

type FsmStatus =
  | 'pending'
  | 'claimed'
  | 'engineering'
  | 'built'
  | 'reviewing'
  | 'revising'
  | 'arbitrating'
  | 'complete'
  | 'failed'
  | 'integrated'
  | 'cycle';

type RequestedTarget =
  | 'engineering'
  | 'built'
  | 'reviewing'
  | 'revising'
  | 'arbitrating'
  | 'complete'
  | 'failed';

const REQUESTED_TARGETS: readonly RequestedTarget[] = [
  'engineering',
  'built',
  'reviewing',
  'revising',
  'arbitrating',
  'complete',
  'failed',
] as const;

const VERDICTS = ['approve', 'request_changes', 'out_of_scope'] as const;
type Verdict = typeof VERDICTS[number];

const ARBITRATION_TRIGGERS = ['review_cycle_budget_exhausted', 'reviewer_contradiction'] as const;
type ArbitrationTrigger = typeof ARBITRATION_TRIGGERS[number];

const FAILURE_REASONS = [
  'review_cycle_budget_exhausted',
  'reviewer_contradiction',
  'engineer_build_failure',
  'reviewer_infrastructure_failure',
  'role_session_no_op',
  'arbitrator_escalated',
] as const;
type FailureReason = typeof FAILURE_REASONS[number];

const BUILD_STATUSES = ['clean', 'dirty', 'failed'] as const;
type BuildStatus = typeof BUILD_STATUSES[number];

// Identifier conventions match agent/project naming (see branch-naming.ts).
const REVIEWER_ROLE_RE = /^[A-Za-z0-9_-]+$/;
const REVIEWER_ROLE_MAX = 64;
const COMMIT_SHA_MAX = 128;
const LATEST_REVIEW_PATH_MAX = 4096;
const FAILURE_DETAIL_MAX = 4096;

interface TransitionPayload {
  // engineering → built
  buildStatus?: string;
  commitSha?: string;

  // reviewing → reviewing (per-reviewer verdict update)
  reviewerRole?: string;
  verdict?: string;

  // reviewing → revising (workspace pointer)
  latestReviewPath?: string;

  // engineering → arbitrating, reviewing → arbitrating
  trigger?: string;
  contradiction?: { findingIds: [number, number]; notes: string };

  // any → failed
  failureReason?: string;
  failureDetail?: string;
}

interface TransitionBody {
  to: string;
  payload?: TransitionPayload;
}

/**
 * The FSM transition table. Keys are the *current* status; each value is the
 * set of legal `to` values reachable from that state via /transition.
 *
 * Note: `pending → claimed` is owned by `POST /tasks/claim-next` and is not
 * exposed through /transition. `complete → integrated` is owned by
 * `POST /tasks/:id/integrate` and is also out of scope here. The FSM
 * intentionally collapses self-loops on `reviewing` into the same `to:
 * 'reviewing'` request; the route layer detects "stay vs. leave" by
 * inspecting the merged verdict object.
 */
const FSM: Record<string, ReadonlySet<RequestedTarget>> = {
  pending: new Set([]),
  claimed: new Set(['engineering', 'failed'] as const),
  engineering: new Set(['built', 'arbitrating', 'failed'] as const),
  built: new Set(['reviewing', 'failed'] as const),
  reviewing: new Set(['reviewing', 'complete', 'revising', 'failed'] as const),
  revising: new Set(['engineering', 'failed'] as const),
  arbitrating: new Set(['complete', 'revising', 'failed'] as const),
  complete: new Set([]),
  failed: new Set([]),
  integrated: new Set([]),
  cycle: new Set([]),
};

// ── Helpers ───────────────────────────────────────────────────────────────

function isVerdict(v: unknown): v is Verdict {
  return typeof v === 'string' && (VERDICTS as readonly string[]).includes(v);
}

function isFailureReason(v: unknown): v is FailureReason {
  return typeof v === 'string' && (FAILURE_REASONS as readonly string[]).includes(v);
}

function isBuildStatus(v: unknown): v is BuildStatus {
  return typeof v === 'string' && (BUILD_STATUSES as readonly string[]).includes(v);
}

function isArbitrationTrigger(v: unknown): v is ArbitrationTrigger {
  return typeof v === 'string' && (ARBITRATION_TRIGGERS as readonly string[]).includes(v);
}

function readVerdicts(raw: unknown): Record<string, string> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }
  return {};
}

/**
 * True iff every declared reviewer (the keys of `verdicts`) has a verdict in
 * {approve, out_of_scope}. Empty maps return false — completion requires at
 * least one declared reviewer.
 */
function allReviewersClear(verdicts: Record<string, string>): boolean {
  const values = Object.values(verdicts);
  if (values.length === 0) return false;
  return values.every((v) => v === 'approve' || v === 'out_of_scope');
}

function anyRequestChanges(verdicts: Record<string, string>): boolean {
  return Object.values(verdicts).some((v) => v === 'request_changes');
}

const tasksLifecyclePlugin: FastifyPluginAsync<TasksOpts> = async (fastify, opts) => {
  const config = opts.config;

  // POST /tasks/:id/reset — reset a complete/failed/cycle task back to pending
  fastify.post<{
    Params: { id: string };
  }>('/tasks/:id/reset', async (request, reply) => {
    const id = Number(request.params.id);
    const db = getDb();

    const row = await tasksCore.getById(db, id);
    if (!row) {
      return reply.notFound('task not found');
    }
    if (row.status !== 'complete' && row.status !== 'failed' && row.status !== 'cycle') {
      return reply.conflict('task can only be reset when complete, failed, or cycle');
    }

    const sp = row.sourcePath;
    if (sp && row.status !== 'cycle') {
      const taskProjectId = row.projectId ?? 'default';
      let project;
      try {
        project = await resolveProject(config, db, taskProjectId);
      } catch {
        // Unknown project — skip sourcePath validation rather than crashing
        project = null;
      }
      if (project) {
        const bareRepo = project.bareRepoPath;
        if (bareRepo) {
          const seedBranch = seedBranchFor(taskProjectId, project);
          if (!existsInBareRepo(bareRepo, seedBranch, sp)) {
            return reply.unprocessableEntity(
              `sourcePath '${sp}' not found on branch '${seedBranch}' in bare repo`
            );
          }
        } else {
          const worktree = project.path;
          if (!isCommittedInRepo(worktree, sp)) {
            return reply.unprocessableEntity(
              `sourcePath '${sp}' is no longer committed in the staging worktree`
            );
          }
        }
      }
    }

    const ok = await tasksLifecycleQ.reset(db, request.projectId, id);
    if (!ok) {
      return reply.conflict('task is no longer in a resettable state');
    }
    return { ok: true };
  });

  // POST /tasks/:id/integrate — mark a single complete task as integrated
  fastify.post<{
    Params: { id: string };
  }>('/tasks/:id/integrate', async (request, reply) => {
    const id = Number(request.params.id);
    const db = getDb();

    const row = await tasksCore.getById(db, id);
    if (!row) {
      return reply.notFound('task not found');
    }
    if (row.status !== 'complete') {
      return reply.badRequest('task must be in complete status to integrate');
    }

    const ok = await tasksLifecycleQ.integrate(db, request.projectId, id);
    if (!ok) {
      return reply.conflict('task status changed concurrently');
    }
    return { ok: true };
  });

  // POST /tasks/integrate-batch — mark all complete tasks by a specific agent as integrated
  fastify.post<{
    Body: { agent: string };
  }>('/tasks/integrate-batch', async (request, reply) => {
    const { agent } = request.body ?? {};
    if (!agent || typeof agent !== 'string') {
      return reply.badRequest('agent must be a string');
    }
    if (!AGENT_NAME_RE.test(agent)) {
      return reply.badRequest('Invalid agent name format');
    }

    const db = getDb();
    const agentRow = await resolveAgent(db, request.projectId, agent);
    if (!agentRow) {
      return reply.notFound(`Agent '${agent}' not found in project '${request.projectId}'`);
    }
    const result = await tasksLifecycleQ.integrateBatch(db, request.projectId, agentRow.id);
    return { ok: true, count: result.count, ids: result.ids };
  });

  // POST /tasks/integrate-all — mark all complete tasks as integrated
  fastify.post('/tasks/integrate-all', async (request) => {
    const db = getDb();
    const result = await tasksLifecycleQ.integrateAll(db, request.projectId);
    return { ok: true, count: result.count, ids: result.ids };
  });

  // POST /tasks/:id/transition — durable FSM transition endpoint
  fastify.post<{
    Params: { id: string };
    Body: TransitionBody;
  }>('/tasks/:id/transition', async (request, reply) => {
    return handleTransition(request, reply);
  });
};

/**
 * Handler for POST /tasks/:id/transition. Pulled out as a named function so
 * the FSM table and helpers above stay first in the file — the table is the
 * load-bearing artefact of this module and should not be obscured by route
 * boilerplate.
 */
async function handleTransition(
  request: FastifyRequest<{ Params: { id: string }; Body: TransitionBody }>,
  reply: FastifyReply,
) {
  // X-Project-Id is mandatory on this endpoint.
  const rawHeader = request.headers['x-project-id'];
  if (rawHeader === undefined || rawHeader === '') {
    return reply.badRequest('X-Project-Id header is required');
  }

  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return reply.badRequest('invalid task id');
  }

  const body = request.body ?? ({} as TransitionBody);
  const to = body.to;
  if (typeof to !== 'string' || !(REQUESTED_TARGETS as readonly string[]).includes(to)) {
    return reply.badRequest(`'to' must be one of: ${REQUESTED_TARGETS.join(', ')}`);
  }
  const target = to as RequestedTarget;
  const payload: TransitionPayload = body.payload ?? {};

  const db = getDb();
  const row = await tasksCore.getById(db, id);
  if (!row) {
    return reply.notFound('task not found');
  }
  if (row.projectId !== request.projectId) {
    return reply.notFound('task not found');
  }

  const current = row.status as FsmStatus;
  const allowed = FSM[current];
  if (!allowed || !allowed.has(target)) {
    return reply.conflict(
      `invalid transition from '${current}' to '${target}'`,
    );
  }

  // Build the per-transition update. Each branch is responsible for:
  //   * validating the payload fields it requires (400 on miss)
  //   * computing the actual `status` written (cycle-budget reroute can flip
  //     `revising` → `arbitrating`)
  //   * setting any per-column writes (build status, verdict merge, etc.)
  //   * arbitration uniqueness guard (409)
  const update: tasksLifecycleQ.TransitionUpdate = { status: target };

  if (target === 'failed') {
    if (!isFailureReason(payload.failureReason)) {
      return reply.badRequest(
        `payload.failureReason is required and must be one of: ${FAILURE_REASONS.join(', ')}`,
      );
    }
    update.failureReason = payload.failureReason;
    if (payload.failureDetail !== undefined) {
      if (typeof payload.failureDetail !== 'string') {
        return reply.badRequest('payload.failureDetail must be a string');
      }
      if (payload.failureDetail.length > FAILURE_DETAIL_MAX) {
        return reply.badRequest(
          `payload.failureDetail exceeds maximum length of ${FAILURE_DETAIL_MAX} characters`,
        );
      }
      update.failureDetail = payload.failureDetail;
    }
    if (current === 'arbitrating') {
      update.arbitrationPendingTrigger = null;
    }
    update.completedAt = new Date();
  } else if (target === 'engineering') {
    // claimed → engineering or revising → engineering. No required payload.
  } else if (target === 'built') {
    if (!isBuildStatus(payload.buildStatus)) {
      return reply.badRequest(
        `payload.buildStatus is required and must be one of: ${BUILD_STATUSES.join(', ')}`,
      );
    }
    if (typeof payload.commitSha !== 'string' || payload.commitSha.length === 0) {
      return reply.badRequest('payload.commitSha is required (non-empty string)');
    }
    if (payload.commitSha.length > COMMIT_SHA_MAX) {
      return reply.badRequest(
        `payload.commitSha exceeds maximum length of ${COMMIT_SHA_MAX} characters`,
      );
    }
    update.buildStatus = payload.buildStatus;
    update.commitSha = payload.commitSha;
  } else if (target === 'reviewing') {
    // Two distinct flows merge into the same target:
    //   built → reviewing       : reset verdicts to {} (cycle entry)
    //   reviewing → reviewing   : single-key verdict merge
    if (current === 'built') {
      update.reviewerVerdicts = {};
    } else if (current === 'reviewing') {
      const role = payload.reviewerRole;
      const verdict = payload.verdict;
      if (typeof role !== 'string' || role.length === 0) {
        return reply.badRequest('payload.reviewerRole is required on reviewing→reviewing');
      }
      if (role.length > REVIEWER_ROLE_MAX) {
        return reply.badRequest(
          `payload.reviewerRole exceeds maximum length of ${REVIEWER_ROLE_MAX} characters`,
        );
      }
      if (!REVIEWER_ROLE_RE.test(role)) {
        return reply.badRequest(
          'payload.reviewerRole must match /^[A-Za-z0-9_-]+$/',
        );
      }
      if (!isVerdict(verdict)) {
        return reply.badRequest(
          `payload.verdict is required and must be one of: ${VERDICTS.join(', ')}`,
        );
      }
      const existing = readVerdicts(row.reviewerVerdicts);
      existing[role] = verdict;
      update.reviewerVerdicts = existing;
    }
  } else if (target === 'revising') {
    // Two legal sources per the FSM:
    //   reviewing → revising   : engineer reads accumulated verdicts and
    //                            decides to revise. Requires latestReviewPath
    //                            (workspace pointer) and at least one
    //                            request_changes verdict already on file.
    //                            Subject to the cycle-budget reroute below —
    //                            if it would push the count past the budget,
    //                            we silently flip the write to `arbitrating`
    //                            with the cycle-budget trigger and DO NOT
    //                            write latestReviewPath.
    //   arbitrating → revising : Phase 7 arbitrator ruled 'rule'; clear the
    //                            pending trigger and move on.
    //                            latestReviewPath is OPTIONAL on this path —
    //                            the arbitrator's ruling is the workspace
    //                            pointer of record. If supplied, validate and
    //                            write it; otherwise leave it untouched.
    if (current === 'reviewing') {
      // Validate latestReviewPath up front: it is required on this edge,
      // even though we may end up not writing it (cycle-budget reroute path).
      if (typeof payload.latestReviewPath !== 'string' || payload.latestReviewPath.length === 0) {
        return reply.badRequest('payload.latestReviewPath is required on reviewing→revising');
      }
      if (payload.latestReviewPath.length > LATEST_REVIEW_PATH_MAX) {
        return reply.badRequest(
          `payload.latestReviewPath exceeds maximum length of ${LATEST_REVIEW_PATH_MAX} characters`,
        );
      }

      // Verdict gate: at least one reviewer must have posted request_changes.
      // The transition table edge is "any verdict == request_changes". An
      // engineer-initiated revising with only approvals/out_of_scope on file
      // would be incoherent.
      const verdicts = readVerdicts(row.reviewerVerdicts);
      if (!anyRequestChanges(verdicts)) {
        return reply.conflict(
          `cannot transition '${current}' → '${target}': no reviewer has posted request_changes`,
        );
      }

      // Cycle-budget guard: increment first, then check.
      const nextCount = (row.reviewCycleCount ?? 0) + 1;
      if (nextCount > (row.reviewCycleBudget ?? 5)) {
        // Reroute: would-be revising becomes arbitrating with cycle-budget trigger.
        const trigger: ArbitrationTrigger = 'review_cycle_budget_exhausted';
        const exists = await tasksLifecycleQ.arbitrationExists(db, id, trigger);
        if (exists) {
          return reply.conflict(
            `arbitration already exists for task ${id} with trigger '${trigger}'`,
          );
        }
        update.status = 'arbitrating';
        update.arbitrationPendingTrigger = trigger;
        update.reviewCycleCount = nextCount;
        // Do not write latestReviewPath — we are not entering revising.
      } else {
        update.latestReviewPath = payload.latestReviewPath;
        update.reviewCycleCount = nextCount;
      }
    } else if (current === 'arbitrating') {
      // arbitrator ruled 'rule'; latestReviewPath optional.
      if (payload.latestReviewPath !== undefined) {
        if (typeof payload.latestReviewPath !== 'string' || payload.latestReviewPath.length === 0) {
          return reply.badRequest(
            'payload.latestReviewPath, if supplied, must be a non-empty string',
          );
        }
        if (payload.latestReviewPath.length > LATEST_REVIEW_PATH_MAX) {
          return reply.badRequest(
            `payload.latestReviewPath exceeds maximum length of ${LATEST_REVIEW_PATH_MAX} characters`,
          );
        }
        update.latestReviewPath = payload.latestReviewPath;
      }
      update.arbitrationPendingTrigger = null;
    }
  } else if (target === 'arbitrating') {
    // Only legal client-driven source: engineering (reviewer_contradiction).
    // The reviewing → arbitrating edge exists only as a server-side reroute
    // inside the `target === 'revising'` branch above (cycle-budget exhausted),
    // and never via a direct `to: 'arbitrating'` request — direct posting
    // would bypass the central cycle-budget check.
    if (!isArbitrationTrigger(payload.trigger)) {
      return reply.badRequest(
        `payload.trigger is required and must be one of: ${ARBITRATION_TRIGGERS.join(', ')}`,
      );
    }
    if (
      current === 'engineering'
      && payload.trigger !== 'reviewer_contradiction'
    ) {
      return reply.badRequest(
        "engineering→arbitrating requires payload.trigger='reviewer_contradiction'",
      );
    }
    const exists = await tasksLifecycleQ.arbitrationExists(db, id, payload.trigger);
    if (exists) {
      return reply.conflict(
        `arbitration already exists for task ${id} with trigger '${payload.trigger}'`,
      );
    }
    update.arbitrationPendingTrigger = payload.trigger;
  } else if (target === 'complete') {
    // Legal sources: reviewing (verdict gate) and arbitrating (ruling=approve).
    if (current === 'reviewing') {
      const verdicts = readVerdicts(row.reviewerVerdicts);
      if (!allReviewersClear(verdicts)) {
        return reply.conflict(
          'cannot transition reviewing→complete: not all declared reviewers have approved or declared out_of_scope',
        );
      }
    } else if (current === 'arbitrating') {
      update.arbitrationPendingTrigger = null;
    }
    update.completedAt = new Date();
  }

  const updated = await tasksLifecycleQ.applyTransition(
    db,
    request.projectId,
    id,
    current,
    update,
  );
  if (!updated) {
    // Lost a race with a concurrent transition.
    return reply.conflict(
      `task ${id} status changed concurrently; expected '${current}'`,
    );
  }

  return {
    ok: true,
    id: updated.id,
    status: updated.status,
    reviewCycleCount: updated.reviewCycleCount,
    reviewerVerdicts: updated.reviewerVerdicts,
    arbitrationPendingTrigger: updated.arbitrationPendingTrigger,
  };
}

export default tasksLifecyclePlugin;
