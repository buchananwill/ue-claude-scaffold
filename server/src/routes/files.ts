import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as filesQ from '../queries/files.js';
import { resolveAgentId } from './route-helpers.js';

const filesPlugin: FastifyPluginAsync = async (fastify) => {
  // GET /files — query the file registry
  fastify.get<{
    Querystring: { claimant?: string; unclaimed?: string; project?: string };
  }>('/files', async (request) => {
    const { claimant, unclaimed, project } = request.query;
    const projectId = project || request.projectId;

    const db = getDb();

    // Resolve claimant name to agent UUID before querying
    let claimantAgentId: string | undefined;
    if (claimant) {
      const agentRow = await resolveAgentId(db, projectId, claimant);
      if (!agentRow) {
        // Agent not found — no files can match, return empty array
        return [];
      }
      claimantAgentId = agentRow.id;
    }

    const rows = await filesQ.list(db, projectId, {
      claimantAgentId,
      unclaimed: unclaimed === 'true',
    });
    return rows.map((r) => ({
      path: r.path,
      // API-compat: external consumers see "claimant"; internal column is claimantAgentId
      claimant: r.claimantAgentId,
      claimedAt: r.claimedAt,
    }));
  });
};

export default filesPlugin;
