import type { FastifyPluginAsync } from 'fastify';
import { tryGetDb } from '../drizzle-instance.js';
import * as filesQ from '../queries/files.js';
import { db } from '../db.js';

interface FileRow {
  path: string;
  claimant: string | null;
  claimed_at: string | null;
}

const filesPlugin: FastifyPluginAsync = async (fastify) => {
  // GET /files — query the file registry
  fastify.get<{
    Querystring: { claimant?: string; unclaimed?: string; project?: string };
  }>('/files', async (request) => {
    const { claimant, unclaimed, project } = request.query;
    const projectId = project || ((request.headers['x-project-id'] as string) || 'default');

    // Use Drizzle if initialised, otherwise fall back to SQLite (transition period)
    const drizzle = tryGetDb();
    if (drizzle) {
      const rows = await filesQ.list(drizzle, projectId, {
        claimant: claimant || undefined,
        unclaimed: unclaimed === 'true',
      });
      return rows.map((r) => ({
        path: r.path,
        claimant: r.claimant,
        claimedAt: r.claimedAt,
      }));
    }

    // SQLite fallback
    let sql = 'SELECT * FROM files WHERE project_id = ?';
    const params: unknown[] = [projectId];

    if (claimant) {
      sql += ' AND claimant = ?';
      params.push(claimant);
    } else if (unclaimed === 'true') {
      sql += ' AND claimant IS NULL';
    }

    sql += ' ORDER BY path ASC';

    const rows = db.prepare(sql).all(...params) as FileRow[];
    return rows.map((r) => ({
      path: r.path,
      claimant: r.claimant,
      claimedAt: r.claimed_at,
    }));
  });
};

export default filesPlugin;
