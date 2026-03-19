import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db.js';

interface FileRow {
  path: string;
  claimant: string | null;
  claimed_at: string | null;
}

const filesPlugin: FastifyPluginAsync = async (fastify) => {
  // GET /files — query the file registry
  fastify.get<{
    Querystring: { claimant?: string; unclaimed?: string };
  }>('/files', async (request) => {
    const { claimant, unclaimed } = request.query;

    let sql = 'SELECT * FROM files';
    const params: unknown[] = [];

    if (claimant) {
      sql += ' WHERE claimant = ?';
      params.push(claimant);
    } else if (unclaimed === 'true') {
      sql += ' WHERE claimant IS NULL';
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
