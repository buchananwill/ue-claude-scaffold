import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db.js';

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

export function formatBuildRecord(row: BuildRow) {
  return {
    id: row.id,
    agent: row.agent,
    type: row.type,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    success: row.success === null ? null : row.success === 1,
    output: row.output,
    stderr: row.stderr,
  };
}

const buildsPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { agent?: string; type?: string; limit?: string; since?: string; project?: string };
  }>('/builds', async (request) => {
    const { agent, type, limit, since, project } = request.query;

    const conditions: string[] = [];
    const params: Record<string, string | number> = {};

    if (agent) {
      conditions.push('agent = @agent');
      params.agent = agent;
    }
    if (type) {
      conditions.push('type = @type');
      params.type = type;
    }
    if (since) {
      conditions.push('id > @since');
      params.since = Number(since);
    }
    if (project) {
      conditions.push('project_id = @project');
      params.project = project;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitVal = Math.max(1, Math.min(isFinite(Number(limit)) ? Number(limit) : 50, 500));

    const stmt = db.prepare(
      `SELECT * FROM build_history ${where} ORDER BY id DESC LIMIT ${limitVal}`
    );

    const rows = stmt.all(params) as BuildRow[];
    return rows.map(formatBuildRecord);
  });
};

export default buildsPlugin;
