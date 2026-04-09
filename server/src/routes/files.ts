import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as filesQ from '../queries/files.js';

const filesPlugin: FastifyPluginAsync = async (fastify) => {
  // GET /files — query the file registry
  fastify.get<{
    Querystring: { claimant?: string; unclaimed?: string; project?: string };
  }>('/files', async (request) => {
    const { claimant, unclaimed, project } = request.query;
    const projectId = project || request.projectId;

    const db = getDb();
    const rows = await filesQ.list(db, projectId, {
      claimantAgentId: claimant || undefined,
      unclaimed: unclaimed === 'true',
    });
    return rows.map((r) => ({
      path: r.path,
      claimant: r.claimantAgentId,
      claimedAt: r.claimedAt,
    }));
  });
};

export default filesPlugin;
