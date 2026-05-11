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
import { requireProjectIdHeader } from './_project-id-guard.js';
import { isUniqueConstraintConflict, reviewerRoleError } from './_route-helpers.js';

const VERDICTS = ['approve', 'request_changes', 'out_of_scope'] as const;
type Verdict = typeof VERDICTS[number];

const SEVERITIES = ['BLOCKING', 'NOTE'] as const;
type Severity = typeof SEVERITIES[number];

const TITLE_MAX = 1024;
const RAW_MARKDOWN_MAX = 512_000;
const DESCRIPTION_MAX = 32_768;
const EVIDENCE_MAX = 32_768;
const FIX_MAX = 32_768;

interface FindingInput {
  severity: Severity;
  ordinal: number;
  filePath?: string | null;
  line?: number | null;
  title: string;
  description: string;
  evidence?: string | null;
  fix?: string | null;
}

interface PostReviewBody {
  cycle: number;
  reviewerRole: string;
  verdict: Verdict;
  rawMarkdown: string;
  findings: FindingInput[];
}

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

function isVerdict(v: unknown): v is Verdict {
  return typeof v === 'string' && (VERDICTS as readonly string[]).includes(v);
}

function isSeverity(v: unknown): v is Severity {
  return typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v);
}

/**
 * Validate one element of `findings[]`. Returns the parsed `FindingInput` on
 * success, or a 400 error message keyed by index on failure.
 *
 * The error wording matches what the inline validator emitted before
 * extraction, so existing tests keep passing without modification.
 */
function validateFinding(f: unknown, i: number): ValidationResult<FindingInput> {
  if (!f || typeof f !== 'object') {
    return { ok: false, message: `findings[${i}] must be an object` };
  }
  const o = f as Record<string, unknown>;

  if (!isSeverity(o.severity)) {
    return {
      ok: false,
      message: `findings[${i}].severity must be one of: ${SEVERITIES.join(', ')}`,
    };
  }
  if (!Number.isInteger(o.ordinal) || (o.ordinal as number) < 0) {
    return {
      ok: false,
      message: `findings[${i}].ordinal must be a non-negative integer`,
    };
  }
  if (typeof o.title !== 'string' || o.title.length === 0) {
    return { ok: false, message: `findings[${i}].title must be a non-empty string` };
  }
  if (o.title.length > TITLE_MAX) {
    return {
      ok: false,
      message: `findings[${i}].title exceeds maximum length of ${TITLE_MAX}`,
    };
  }
  if (typeof o.description !== 'string') {
    return { ok: false, message: `findings[${i}].description must be a string` };
  }
  if (o.description.length > DESCRIPTION_MAX) {
    return {
      ok: false,
      message: `findings[${i}].description exceeds maximum length of ${DESCRIPTION_MAX}`,
    };
  }
  if (o.filePath !== undefined && o.filePath !== null && typeof o.filePath !== 'string') {
    return { ok: false, message: `findings[${i}].filePath must be a string` };
  }
  if (
    o.line !== undefined
    && o.line !== null
    && (!Number.isInteger(o.line) || (o.line as number) < 0)
  ) {
    return {
      ok: false,
      message: `findings[${i}].line must be a non-negative integer`,
    };
  }
  if (o.evidence !== undefined && o.evidence !== null && typeof o.evidence !== 'string') {
    return { ok: false, message: `findings[${i}].evidence must be a string` };
  }
  if (
    o.evidence !== undefined
    && o.evidence !== null
    && (o.evidence as string).length > EVIDENCE_MAX
  ) {
    return {
      ok: false,
      message: `findings[${i}].evidence exceeds maximum length of ${EVIDENCE_MAX}`,
    };
  }
  if (o.fix !== undefined && o.fix !== null && typeof o.fix !== 'string') {
    return { ok: false, message: `findings[${i}].fix must be a string` };
  }
  if (o.fix !== undefined && o.fix !== null && (o.fix as string).length > FIX_MAX) {
    return {
      ok: false,
      message: `findings[${i}].fix exceeds maximum length of ${FIX_MAX}`,
    };
  }

  return {
    ok: true,
    value: {
      severity: o.severity,
      ordinal: o.ordinal as number,
      filePath: (o.filePath as string | null | undefined) ?? null,
      line: (o.line as number | null | undefined) ?? null,
      title: o.title,
      description: o.description,
      evidence: (o.evidence as string | null | undefined) ?? null,
      fix: (o.fix as string | null | undefined) ?? null,
    },
  };
}

/**
 * Validate the `POST /tasks/:id/reviews` request body. Returns the typed
 * body on success, or a 400 error message on failure. Pure mechanical
 * extraction of the inline validation that previously ran in the handler —
 * no behaviour change, no message change.
 */
function validatePostReviewBody(raw: unknown): ValidationResult<PostReviewBody> {
  const body = (raw ?? {}) as Record<string, unknown>;

  if (!Number.isInteger(body.cycle) || (body.cycle as number) < 0) {
    return { ok: false, message: 'cycle must be a non-negative integer' };
  }
  if (typeof body.reviewerRole !== 'string' || body.reviewerRole.length === 0) {
    return { ok: false, message: 'reviewerRole must be a non-empty string' };
  }
  const reviewerErr = reviewerRoleError(body.reviewerRole, 'reviewerRole');
  if (reviewerErr !== null) return { ok: false, message: reviewerErr };
  if (!isVerdict(body.verdict)) {
    return {
      ok: false,
      message: `verdict must be one of: ${VERDICTS.join(', ')}`,
    };
  }
  if (typeof body.rawMarkdown !== 'string') {
    return { ok: false, message: 'rawMarkdown must be a string' };
  }
  if ((body.rawMarkdown as string).length > RAW_MARKDOWN_MAX) {
    return {
      ok: false,
      message: `rawMarkdown exceeds maximum length of ${RAW_MARKDOWN_MAX}`,
    };
  }

  const findings = Array.isArray(body.findings) ? (body.findings as unknown[]) : null;
  if (findings === null) {
    return { ok: false, message: 'findings must be an array (use [] for none)' };
  }

  const validatedFindings: FindingInput[] = [];
  for (let i = 0; i < findings.length; i++) {
    const v = validateFinding(findings[i], i);
    if (!v.ok) return { ok: false, message: v.message };
    validatedFindings.push(v.value);
  }

  return {
    ok: true,
    value: {
      cycle: body.cycle as number,
      reviewerRole: body.reviewerRole,
      verdict: body.verdict,
      rawMarkdown: body.rawMarkdown as string,
      findings: validatedFindings,
    },
  };
}

const reviewsPlugin: FastifyPluginAsync = async (fastify) => {
  // POST /tasks/:id/reviews — atomic run + findings insert
  fastify.post<{
    Params: { id: string };
    Body: unknown;
  }>('/tasks/:id/reviews', async (request, reply) => {
    // X-Project-Id is mandatory on this endpoint. The project-id plugin
    // silently substitutes 'default' on a missing header — the shared guard
    // re-keys off the raw header so a missing or empty value surfaces as 400.
    if (!requireProjectIdHeader(request, reply)) return;

    const taskId = Number(request.params.id);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return reply.badRequest('invalid task id');
    }

    const v = validatePostReviewBody(request.body);
    if (!v.ok) return reply.badRequest(v.message);
    const body = v.value;

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
        if (body.findings.length > 0) {
          const rows = body.findings.map((f) => ({
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
      if (isUniqueConstraintConflict(err, 'review_runs_task_cycle_role_unique')) {
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
    // X-Project-Id is mandatory on this endpoint. See the POST handler for
    // the rationale on inspecting the raw header rather than
    // `request.projectId`.
    if (!requireProjectIdHeader(request, reply)) return;

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
