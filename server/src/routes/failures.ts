/**
 * Cross-task failure-reason aggregation.
 *
 *   GET /failures/reasons — counts of `tasks.failure_reason` for `status =
 *                           'failed'` rows over the trailing window,
 *                           project-scoped, with up to 3 example task IDs per
 *                           reason ordered by `completed_at DESC`.
 *
 * The dashboard pads the response with zero-count entries client-side so all
 * six enum values render in the panel; the server only returns reasons that
 * actually occurred in the window.
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { sql } from 'drizzle-orm';
import { getDb } from '../drizzle-instance.js';

const DEFAULT_SINCE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function requireProjectIdHeader(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const raw = request.headers['x-project-id'];
  if (raw === undefined || raw === '') {
    reply.badRequest('X-Project-Id header is required');
    return false;
  }
  return true;
}

function parseSince(raw: string | undefined): Date | null {
  if (raw === undefined || raw === '') {
    return new Date(Date.now() - DEFAULT_SINCE_MS);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Drivers vary in how they return Postgres array columns. node-postgres returns
 * a JS array; PGlite sometimes returns the Postgres text representation
 * `{1,2,3}`. Normalise both to `number[]`.
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

const failuresPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { since?: string };
  }>('/failures/reasons', async (request, reply) => {
    if (!requireProjectIdHeader(request, reply)) return;

    const projectId = request.projectId;
    const since = parseSince(request.query?.since);
    if (since === null) {
      return reply.badRequest('since must be an ISO 8601 date');
    }

    const db = getDb();

    // CTE replicates the `ARRAY_AGG(... ORDER BY completed_at DESC LIMIT 3)`
    // shape — Postgres does not allow LIMIT directly inside array_agg.
    const result = await db.execute(sql`
      WITH ranked AS (
        SELECT
          id,
          failure_reason,
          completed_at,
          ROW_NUMBER() OVER (
            PARTITION BY failure_reason
            ORDER BY completed_at DESC, id DESC
          ) AS rn
        FROM tasks
        WHERE project_id = ${projectId}
          AND status = 'failed'
          AND failure_reason IS NOT NULL
          AND completed_at >= ${since}
      )
      SELECT
        failure_reason,
        COUNT(*)::int AS count,
        ARRAY_AGG(id ORDER BY completed_at DESC, id DESC)
          FILTER (WHERE rn <= 3) AS example_task_ids
      FROM ranked
      GROUP BY failure_reason
      ORDER BY count DESC, failure_reason ASC
    `);

    const rows = (result as unknown as { rows: Array<{
      failure_reason: string;
      count: number | string;
      example_task_ids: number[] | string | null;
    }> }).rows;

    return {
      patterns: rows.map((r) => ({
        failureReason: r.failure_reason,
        count: Number(r.count),
        exampleTaskIds: normalizeIdArray(r.example_task_ids),
      })),
    };
  });
};

export default failuresPlugin;
