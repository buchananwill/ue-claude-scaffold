import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as buildsQ from '../queries/builds.js';

export interface BuildRow {
  id: number;
  agent: string;
  type: string;
  started_at: string;
  duration_ms: number | null;
  success: number | null;
  output: string | null;
  stderr: string | null;
}

export function formatBuildRecord(row: any) {
  return {
    id: row.id,
    agent: row.agent,
    type: row.type,
    startedAt: row.startedAt ?? row.started_at,
    durationMs: row.durationMs ?? row.duration_ms ?? null,
    success: row.success === null || row.success === undefined ? null : row.success === 1 || row.success === true,
    output: row.output ?? null,
    stderr: row.stderr ?? null,
  };
}

const buildsPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { agent?: string; type?: string; limit?: string; since?: string; project?: string };
  }>('/builds', async (request) => {
    const { agent, type, limit, since, project } = request.query;

    const limitVal = Math.max(1, Math.min(isFinite(Number(limit)) ? Number(limit) : 50, 500));

    const rows = await buildsQ.list(getDb(), {
      agent: agent || undefined,
      type: type || undefined,
      since: since ? Number(since) : undefined,
      project: project || undefined,
      limit: limitVal,
    });

    return rows.map(formatBuildRecord);
  });
};

export default buildsPlugin;
