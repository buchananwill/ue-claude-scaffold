/**
 * Cross-task review findings and arbitration aggregations.
 *
 *   GET /findings              — recent BLOCKING (or NOTE) finding list,
 *                                project-scoped via `tasks.project_id`.
 *   GET /findings/note-patterns — NOTE titles grouped by exact-match count, top-N.
 *   GET /arbitrations           — `(trigger, ruling)` counts over the window.
 *
 * All endpoints require `X-Project-Id` (rejected with 400 if missing). The
 * `project-id` plugin already validates the format and decorates
 * `request.projectId`, but it silently substitutes 'default' on a missing
 * header; we explicitly inspect the raw header here to honour the plan's
 * "reject missing header with 400" requirement.
 *
 * The example-IDs columns on `/findings/note-patterns` and `/arbitrations`
 * replicate `ARRAY_AGG(... ORDER BY ... LIMIT 3)`. PostgreSQL does not allow
 * `LIMIT` directly inside `array_agg`, so we use a CTE with `row_number()`
 * windowed over the grouping key, filter to `rn <= 3`, then aggregate.
 */
import type { FastifyPluginAsync } from 'fastify';
import { eq, and, desc, sql } from 'drizzle-orm';
import { getDb } from '../drizzle-instance.js';
import {
  reviewRuns,
  reviewFindings,
  tasks,
} from '../schema/tables.js';
import { requireProjectIdHeader } from './_project-id-guard.js';

const DEFAULT_FINDINGS_LIMIT = 50;
const MAX_FINDINGS_LIMIT = 200;
const DEFAULT_NOTE_PATTERNS_LIMIT = 20;
const MAX_NOTE_PATTERNS_LIMIT = 50;
const DEFAULT_SINCE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SEVERITIES = ['BLOCKING', 'NOTE'] as const;
type Severity = typeof SEVERITIES[number];
const REVIEWER_ROLE_RE = /^[A-Za-z0-9_-]+$/;
const REVIEWER_ROLE_MAX = 64;

/**
 * Sentinel for parseLimit failures. A return of `null` means "value supplied
 * but invalid" (caller should reply 400); any number return is the parsed
 * limit (clamped) or the default for a missing value.
 */
const LIMIT_INVALID = null;

/**
 * Parse and clamp the `limit` query param.
 *
 * - Undefined or empty → return `def`.
 * - Non-positive (`0`, negative) or non-numeric → return `LIMIT_INVALID` so
 *   the caller can reply 400. Silently falling back to the default would mask
 *   client bugs.
 * - Positive finite numbers are floored and clamped to `max`.
 */
function parseLimit(
  raw: string | undefined,
  def: number,
  max: number,
): number | typeof LIMIT_INVALID {
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return LIMIT_INVALID;
  return Math.min(Math.floor(n), max);
}

function parseOffset(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Parse a `since` query parameter as an ISO date string. Returns the parsed
 * Date or the default (now − 30 days) if absent. Returns `null` if the
 * supplied value is non-empty but unparseable — the caller turns that into a
 * 400.
 */
function parseSince(raw: string | undefined): Date | null {
  if (raw === undefined || raw === '') {
    return new Date(Date.now() - DEFAULT_SINCE_MS);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

const findingsPlugin: FastifyPluginAsync = async (fastify) => {
  // ── GET /findings ────────────────────────────────────────────────────
  fastify.get<{
    Querystring: {
      severity?: string;
      reviewer?: string;
      since?: string;
      limit?: string;
      offset?: string;
    };
  }>('/findings', async (request, reply) => {
    if (!requireProjectIdHeader(request, reply)) return;

    const projectId = request.projectId;
    const q = request.query ?? {};

    // Validate the supplied severity *before* narrowing it. Falling through
    // with a default would silently drop bad client input.
    if (q.severity !== undefined && !(SEVERITIES as readonly string[]).includes(q.severity)) {
      return reply.badRequest(
        `severity must be one of: ${SEVERITIES.join(', ')}`,
      );
    }
    const severity: Severity = q.severity === 'NOTE' ? 'NOTE' : 'BLOCKING';

    const since = parseSince(q.since);
    if (since === null) {
      return reply.badRequest('since must be an ISO 8601 date');
    }

    let reviewer: string | null = null;
    if (typeof q.reviewer === 'string' && q.reviewer.length > 0) {
      if (q.reviewer.length > REVIEWER_ROLE_MAX) {
        return reply.badRequest(
          `reviewer exceeds maximum length of ${REVIEWER_ROLE_MAX}`,
        );
      }
      if (!REVIEWER_ROLE_RE.test(q.reviewer)) {
        return reply.badRequest('reviewer must match /^[A-Za-z0-9_-]+$/');
      }
      reviewer = q.reviewer;
    }

    const limit = parseLimit(q.limit, DEFAULT_FINDINGS_LIMIT, MAX_FINDINGS_LIMIT);
    if (limit === LIMIT_INVALID) {
      return reply.badRequest('limit must be a positive integer');
    }
    const offset = parseOffset(q.offset);

    const db = getDb();

    const conditions = [
      eq(tasks.projectId, projectId),
      eq(reviewFindings.severity, severity),
      sql`${reviewRuns.postedAt} >= ${since}`,
    ];
    if (reviewer !== null) {
      conditions.push(eq(reviewRuns.reviewerRole, reviewer));
    }
    const whereClause = and(...conditions);

    const rows = await db
      .select({
        id: reviewFindings.id,
        taskId: reviewRuns.taskId,
        cycle: reviewRuns.cycle,
        reviewerRole: reviewRuns.reviewerRole,
        severity: reviewFindings.severity,
        filePath: reviewFindings.filePath,
        line: reviewFindings.line,
        title: reviewFindings.title,
        postedAt: reviewRuns.postedAt,
      })
      .from(reviewFindings)
      .innerJoin(reviewRuns, eq(reviewRuns.id, reviewFindings.runId))
      .innerJoin(tasks, eq(tasks.id, reviewRuns.taskId))
      .where(whereClause)
      .orderBy(desc(reviewRuns.postedAt), desc(reviewFindings.id))
      .limit(limit)
      .offset(offset);

    const totalRow = await db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(reviewFindings)
      .innerJoin(reviewRuns, eq(reviewRuns.id, reviewFindings.runId))
      .innerJoin(tasks, eq(tasks.id, reviewRuns.taskId))
      .where(whereClause);
    const total = Number(totalRow[0]?.c ?? 0);

    return {
      findings: rows.map((r) => ({
        id: r.id,
        taskId: r.taskId,
        cycle: r.cycle,
        reviewerRole: r.reviewerRole,
        severity: r.severity,
        filePath: r.filePath,
        line: r.line,
        title: r.title,
        postedAt: r.postedAt,
      })),
      total,
    };
  });

  // ── GET /findings/note-patterns ──────────────────────────────────────
  fastify.get<{
    Querystring: { since?: string; limit?: string };
  }>('/findings/note-patterns', async (request, reply) => {
    if (!requireProjectIdHeader(request, reply)) return;

    const projectId = request.projectId;
    const q = request.query ?? {};

    const since = parseSince(q.since);
    if (since === null) {
      return reply.badRequest('since must be an ISO 8601 date');
    }
    const limit = parseLimit(q.limit, DEFAULT_NOTE_PATTERNS_LIMIT, MAX_NOTE_PATTERNS_LIMIT);
    if (limit === LIMIT_INVALID) {
      return reply.badRequest('limit must be a positive integer');
    }

    const db = getDb();

    // CTE: rank NOTE findings within each title group by posted_at DESC. The
    // outer aggregate keeps only rn <= 3 inside array_agg, achieving the
    // "examples LIMIT 3 ORDER BY posted_at DESC" semantics that PostgreSQL
    // does not let you express directly inside ARRAY_AGG.
    const result = await db.execute(sql`
      WITH ranked AS (
        SELECT
          rf.id AS finding_id,
          rf.title AS title,
          rr.posted_at AS posted_at,
          ROW_NUMBER() OVER (
            PARTITION BY rf.title
            ORDER BY rr.posted_at DESC, rf.id DESC
          ) AS rn
        FROM review_findings rf
        INNER JOIN review_runs rr ON rr.id = rf.run_id
        INNER JOIN tasks t ON t.id = rr.task_id
        WHERE t.project_id = ${projectId}
          AND rf.severity = 'NOTE'
          AND rr.posted_at >= ${since}
      )
      SELECT
        title,
        COUNT(*)::int AS count,
        ARRAY_AGG(finding_id ORDER BY posted_at DESC, finding_id DESC)
          FILTER (WHERE rn <= 3) AS example_finding_ids
      FROM ranked
      GROUP BY title
      ORDER BY count DESC, title ASC
      LIMIT ${limit}
    `);

    const rows = (result as unknown as { rows: Array<{
      title: string;
      count: number | string;
      example_finding_ids: number[] | string | null;
    }> }).rows;

    return {
      patterns: rows.map((r) => ({
        title: r.title,
        count: Number(r.count),
        exampleFindingIds: normalizeIdArray(r.example_finding_ids),
      })),
    };
  });

  // ── GET /arbitrations ────────────────────────────────────────────────
  fastify.get<{
    Querystring: { since?: string };
  }>('/arbitrations', async (request, reply) => {
    if (!requireProjectIdHeader(request, reply)) return;

    const projectId = request.projectId;
    const q = request.query ?? {};

    const since = parseSince(q.since);
    if (since === null) {
      return reply.badRequest('since must be an ISO 8601 date');
    }

    const db = getDb();

    const result = await db.execute(sql`
      WITH ranked AS (
        SELECT
          ar.task_id AS task_id,
          ar.trigger AS trigger,
          ar.ruling AS ruling,
          ar.posted_at AS posted_at,
          ROW_NUMBER() OVER (
            PARTITION BY ar.trigger, ar.ruling
            ORDER BY ar.posted_at DESC, ar.task_id DESC
          ) AS rn
        FROM arbitration_runs ar
        INNER JOIN tasks t ON t.id = ar.task_id
        WHERE t.project_id = ${projectId}
          AND ar.posted_at >= ${since}
      )
      SELECT
        trigger,
        ruling,
        COUNT(*)::int AS count,
        ARRAY_AGG(task_id ORDER BY posted_at DESC, task_id DESC)
          FILTER (WHERE rn <= 3) AS example_task_ids
      FROM ranked
      GROUP BY trigger, ruling
      ORDER BY count DESC, trigger ASC, ruling ASC
    `);

    const rows = (result as unknown as { rows: Array<{
      trigger: string;
      ruling: string;
      count: number | string;
      example_task_ids: number[] | string | null;
    }> }).rows;

    return {
      patterns: rows.map((r) => ({
        trigger: r.trigger,
        ruling: r.ruling,
        count: Number(r.count),
        exampleTaskIds: normalizeIdArray(r.example_task_ids),
      })),
    };
  });
};

/**
 * Normalise the shape of an array column returned by `db.execute(sql\`...\`)`.
 * Drivers vary: node-postgres returns a JS array, PGlite sometimes returns the
 * Postgres text representation `{1,2,3}`. Convert both to a `number[]`.
 */
function normalizeIdArray(raw: number[] | string | null | undefined): number[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  if (typeof raw === 'string') {
    const trimmed = raw.replace(/^\{|\}$/g, '');
    if (trimmed.length === 0) return [];
    return trimmed.split(',').map((s) => Number(s)).filter((n) => Number.isFinite(n));
  }
  return [];
}

export default findingsPlugin;
