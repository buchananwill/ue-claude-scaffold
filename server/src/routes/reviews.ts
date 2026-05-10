/**
 * Review-run ingestion and per-task fetch.
 *
 *   POST /tasks/:id/reviews         — atomically insert one review run plus
 *                                     N findings.
 *   GET  /tasks/:id/reviews/:cycle  — return the per-run breakdown for that
 *                                     cycle.
 *
 * The unique constraint `review_runs_task_cycle_role_unique` is the dedupe
 * key — reposting the same `(taskId, cycle, reviewerRole)` returns 409.
 * Findings can be empty (an `approve` or `out_of_scope` verdict need not carry
 * findings); an `approve` may still carry NOTE findings, count unconstrained.
 */
import type { FastifyPluginAsync } from 'fastify';
import { eq, and, asc, inArray } from 'drizzle-orm';
import { getDb } from '../drizzle-instance.js';
import { reviewRuns, reviewFindings, tasks } from '../schema/tables.js';

const VERDICTS = ['approve', 'request_changes', 'out_of_scope'] as const;
type Verdict = typeof VERDICTS[number];

const SEVERITIES = ['BLOCKING', 'NOTE'] as const;
type Severity = typeof SEVERITIES[number];

const REVIEWER_ROLE_RE = /^[A-Za-z0-9_-]+$/;
const REVIEWER_ROLE_MAX = 64;
const TITLE_MAX = 1024;
const RAW_MARKDOWN_MAX = 512_000;
const DESCRIPTION_MAX = 32_768;
const EVIDENCE_MAX = 32_768;
const FIX_MAX = 32_768;

interface FindingInput {
  severity: string;
  ordinal: number;
  filePath?: string | null;
  line?: number | null;
  title: string;
  description: string;
  evidence?: string | null;
  fix?: string | null;
}

interface PostBody {
  cycle: number;
  reviewerRole: string;
  verdict: string;
  rawMarkdown: string;
  findings: FindingInput[];
}

function isVerdict(v: unknown): v is Verdict {
  return typeof v === 'string' && (VERDICTS as readonly string[]).includes(v);
}

function isSeverity(v: unknown): v is Severity {
  return typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v);
}

/**
 * Detect whether an error from a Drizzle insert corresponds to a unique
 * violation on `review_runs_task_cycle_role_unique`. Both PG (node-postgres)
 * and PGlite surface unique violations with SQLSTATE 23505; the constraint
 * name appears either in `.constraint_name`, `.constraint`, or in the message
 * text. We match permissively because driver shapes drift between releases.
 */
function isUniqueRunConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown> & { cause?: unknown };
  const code = e.code;
  const message = typeof e.message === 'string' ? e.message : '';
  const constraint =
    (typeof e.constraint === 'string' && e.constraint)
    || (typeof e.constraint_name === 'string' && e.constraint_name)
    || '';
  const matchesConstraint =
    constraint === 'review_runs_task_cycle_role_unique'
    || message.includes('review_runs_task_cycle_role_unique');
  if (matchesConstraint) return true;
  // PGlite sometimes wraps the underlying error
  if (e.cause) {
    return isUniqueRunConflict(e.cause);
  }
  return code === '23505' && message.toLowerCase().includes('unique');
}

const reviewsPlugin: FastifyPluginAsync = async (fastify) => {
  // POST /tasks/:id/reviews — atomic run + findings insert
  fastify.post<{
    Params: { id: string };
    Body: PostBody;
  }>('/tasks/:id/reviews', async (request, reply) => {
    // X-Project-Id is mandatory on this endpoint. The project-id plugin
    // silently substitutes 'default' on a missing header — re-key off the raw
    // header so a missing header surfaces as 400 rather than silently scoping
    // the request to the wrong project.
    const rawHeader = request.headers['x-project-id'];
    if (rawHeader === undefined || rawHeader === '') {
      return reply.badRequest('X-Project-Id header is required');
    }

    const taskId = Number(request.params.id);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return reply.badRequest('invalid task id');
    }

    const body = request.body ?? ({} as PostBody);

    // ── body validation ────────────────────────────────────────────────
    if (!Number.isInteger(body.cycle) || body.cycle < 0) {
      return reply.badRequest('cycle must be a non-negative integer');
    }
    if (typeof body.reviewerRole !== 'string' || body.reviewerRole.length === 0) {
      return reply.badRequest('reviewerRole must be a non-empty string');
    }
    if (body.reviewerRole.length > REVIEWER_ROLE_MAX) {
      return reply.badRequest(
        `reviewerRole exceeds maximum length of ${REVIEWER_ROLE_MAX}`,
      );
    }
    if (!REVIEWER_ROLE_RE.test(body.reviewerRole)) {
      return reply.badRequest('reviewerRole must match /^[A-Za-z0-9_-]+$/');
    }
    if (!isVerdict(body.verdict)) {
      return reply.badRequest(
        `verdict must be one of: ${VERDICTS.join(', ')}`,
      );
    }
    if (typeof body.rawMarkdown !== 'string') {
      return reply.badRequest('rawMarkdown must be a string');
    }
    if (body.rawMarkdown.length > RAW_MARKDOWN_MAX) {
      return reply.badRequest(
        `rawMarkdown exceeds maximum length of ${RAW_MARKDOWN_MAX}`,
      );
    }
    const findings = Array.isArray(body.findings) ? body.findings : null;
    if (findings === null) {
      return reply.badRequest('findings must be an array (use [] for none)');
    }

    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      if (!f || typeof f !== 'object') {
        return reply.badRequest(`findings[${i}] must be an object`);
      }
      if (!isSeverity(f.severity)) {
        return reply.badRequest(
          `findings[${i}].severity must be one of: ${SEVERITIES.join(', ')}`,
        );
      }
      if (!Number.isInteger(f.ordinal) || f.ordinal < 0) {
        return reply.badRequest(
          `findings[${i}].ordinal must be a non-negative integer`,
        );
      }
      if (typeof f.title !== 'string' || f.title.length === 0) {
        return reply.badRequest(`findings[${i}].title must be a non-empty string`);
      }
      if (f.title.length > TITLE_MAX) {
        return reply.badRequest(
          `findings[${i}].title exceeds maximum length of ${TITLE_MAX}`,
        );
      }
      if (typeof f.description !== 'string') {
        return reply.badRequest(`findings[${i}].description must be a string`);
      }
      if (f.description.length > DESCRIPTION_MAX) {
        return reply.badRequest(
          `findings[${i}].description exceeds maximum length of ${DESCRIPTION_MAX}`,
        );
      }
      if (f.filePath !== undefined && f.filePath !== null && typeof f.filePath !== 'string') {
        return reply.badRequest(`findings[${i}].filePath must be a string`);
      }
      if (f.line !== undefined && f.line !== null && (!Number.isInteger(f.line) || f.line < 0)) {
        return reply.badRequest(
          `findings[${i}].line must be a non-negative integer`,
        );
      }
      if (f.evidence !== undefined && f.evidence !== null && typeof f.evidence !== 'string') {
        return reply.badRequest(`findings[${i}].evidence must be a string`);
      }
      if (f.evidence !== undefined && f.evidence !== null && f.evidence.length > EVIDENCE_MAX) {
        return reply.badRequest(
          `findings[${i}].evidence exceeds maximum length of ${EVIDENCE_MAX}`,
        );
      }
      if (f.fix !== undefined && f.fix !== null && typeof f.fix !== 'string') {
        return reply.badRequest(`findings[${i}].fix must be a string`);
      }
      if (f.fix !== undefined && f.fix !== null && f.fix.length > FIX_MAX) {
        return reply.badRequest(
          `findings[${i}].fix exceeds maximum length of ${FIX_MAX}`,
        );
      }
    }

    const db = getDb();

    // Ensure the task exists in the requesting project; without this the FK
    // cascade would simply reject the run insert (or, worse, accept a row
    // pointing at a task in another project), but we want a clean 404 for the
    // operator. We deliberately use the same response shape for "no such task"
    // and "task in another project" to avoid leaking task existence across
    // projects.
    const taskRow = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, request.projectId)))
      .limit(1);
    if (taskRow.length === 0) {
      return reply.notFound('task not found');
    }

    try {
      const result = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(reviewRuns)
          .values({
            taskId,
            cycle: body.cycle,
            reviewerRole: body.reviewerRole,
            verdict: body.verdict,
            rawMarkdown: body.rawMarkdown,
          })
          .returning();
        const runId = inserted[0]!.id;

        let findingIds: number[] = [];
        if (findings.length > 0) {
          const rows = findings.map((f) => ({
            runId,
            severity: f.severity,
            ordinal: f.ordinal,
            filePath: f.filePath ?? null,
            line: f.line ?? null,
            title: f.title,
            description: f.description,
            evidence: f.evidence ?? null,
            fix: f.fix ?? null,
          }));
          const findingRows = await tx
            .insert(reviewFindings)
            .values(rows)
            .returning();
          findingIds = findingRows.map((r) => r.id);
        }

        return { runId, findingIds };
      });

      return result;
    } catch (err) {
      if (isUniqueRunConflict(err)) {
        return reply.conflict(
          `review run already exists for task ${taskId}, cycle ${body.cycle}, reviewerRole '${body.reviewerRole}'`,
        );
      }
      throw err;
    }
  });

  // GET /tasks/:id/reviews/:cycle — per-run breakdown for a single cycle
  fastify.get<{
    Params: { id: string; cycle: string };
  }>('/tasks/:id/reviews/:cycle', async (request, reply) => {
    // X-Project-Id is mandatory on this endpoint. See the POST handler for the
    // rationale on inspecting the raw header rather than `request.projectId`.
    const rawHeader = request.headers['x-project-id'];
    if (rawHeader === undefined || rawHeader === '') {
      return reply.badRequest('X-Project-Id header is required');
    }

    const taskId = Number(request.params.id);
    const cycle = Number(request.params.cycle);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return reply.badRequest('invalid task id');
    }
    if (!Number.isInteger(cycle) || cycle < 0) {
      return reply.badRequest('invalid cycle');
    }

    const db = getDb();

    // Confirm the task exists in this project before exposing review markdown.
    // A task that belongs to another project must surface as 404 to match the
    // POST endpoint's symmetry and to avoid leaking review content cross-
    // project. An "absent cycle" still returns the empty-runs shape — that
    // distinction matters because the dashboard polls for cycles that have not
    // yet been posted.
    const taskRow = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, request.projectId)))
      .limit(1);
    if (taskRow.length === 0) {
      return reply.notFound('task not found');
    }

    const runs = await db
      .select({
        id: reviewRuns.id,
        reviewerRole: reviewRuns.reviewerRole,
        verdict: reviewRuns.verdict,
        rawMarkdown: reviewRuns.rawMarkdown,
      })
      .from(reviewRuns)
      .where(and(eq(reviewRuns.taskId, taskId), eq(reviewRuns.cycle, cycle)))
      .orderBy(asc(reviewRuns.id));

    if (runs.length === 0) {
      return { cycle, runs: [] };
    }

    const runIds = runs.map((r) => r.id);
    // Pull all findings for the runs in one query, then bucket per-run.
    const findingsRows = await db
      .select({
        id: reviewFindings.id,
        runId: reviewFindings.runId,
        severity: reviewFindings.severity,
        ordinal: reviewFindings.ordinal,
        filePath: reviewFindings.filePath,
        line: reviewFindings.line,
        title: reviewFindings.title,
        description: reviewFindings.description,
        evidence: reviewFindings.evidence,
        fix: reviewFindings.fix,
      })
      .from(reviewFindings)
      .where(inArray(reviewFindings.runId, runIds))
      .orderBy(asc(reviewFindings.runId), asc(reviewFindings.ordinal), asc(reviewFindings.id));

    const byRun = new Map<number, typeof findingsRows>();
    for (const f of findingsRows) {
      const arr = byRun.get(f.runId) ?? [];
      arr.push(f);
      byRun.set(f.runId, arr);
    }

    return {
      cycle,
      runs: runs.map((r) => ({
        reviewerRole: r.reviewerRole,
        verdict: r.verdict,
        rawMarkdown: r.rawMarkdown,
        findings: (byRun.get(r.id) ?? []).map((f) => ({
          id: f.id,
          severity: f.severity,
          ordinal: f.ordinal,
          filePath: f.filePath,
          line: f.line,
          title: f.title,
          description: f.description,
          evidence: f.evidence,
          fix: f.fix,
        })),
      })),
    };
  });
};

export default reviewsPlugin;
