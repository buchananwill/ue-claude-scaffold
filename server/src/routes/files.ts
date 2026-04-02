import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as filesQ from '../queries/files.js';

const filesPlugin: FastifyPluginAsync = async (fastify) => {
  // GET /files — query the file registry
  fastify.get<{
    Querystring: { claimant?: string; unclaimed?: string; project?: string };
  }>('/files', async (request) => {
    const { claimant, unclaimed, project } = request.query;
    const projectId = project || ((request.headers['x-project-id'] as string) || 'default');

    const db = getDb();
    const rows = await filesQ.list(db, projectId, {
      claimant: claimant || undefined,
      unclaimed: unclaimed === 'true',
    });
    return rows.map((r) => ({
      path: r.path,
      claimant: r.claimant,
      claimedAt: r.claimedAt,
    }));
  });
};

export default filesPlugin;
