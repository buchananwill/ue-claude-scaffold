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
import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { getDb } from '../drizzle-instance.js';
import { requireProjectIdHeader } from './_project-id-guard.js';
import { normalizeIdArray, parseSinceParam, rowsOf } from './_route-helpers.js';

const failuresPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { since?: string };
  }>('/failures/reasons', async (request, reply) => {
    if (!requireProjectIdHeader(request, reply)) return;

    const projectId = request.projectId;
    const since = parseSinceParam(reply, request.query?.since);
    if (since === null) return;

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

    const rows = rowsOf<{
      failure_reason: string;
      count: number | string;
      example_task_ids: number[] | string | null;
    }>(result);

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
