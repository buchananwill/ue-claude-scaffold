import type { FastifyPluginAsync } from 'fastify';
import type { ScaffoldConfig } from '../config.js';
import { getProject } from '../config.js';
import { syncExteriorToBareRepo, mergeIntoBranch } from '../git-utils.js';
import { getDb } from '../drizzle-instance.js';
import * as agentsQ from '../queries/agents.js';
import * as projectsQ from '../queries/projects.js';
import { seedBranchFor, agentBranchFor } from '../branch-naming.js';

interface SyncOpts {
  config: ScaffoldConfig;
}

const syncPlugin: FastifyPluginAsync<SyncOpts> = async (fastify, opts) => {
  const { config } = opts;

  // POST /sync/plans — merge committed state from exterior repo into bare repo's seed branch.
  // The exterior repo (config.project.path) is the source of truth for plans.
  // This endpoint fetches its HEAD into a temp branch, merges into docker/{projectId}/current-root (via seedBranchFor),
  // and optionally propagates to agent branches.
  fastify.post<{
    Body: { targetAgents?: string[] | string };
  }>('/sync/plans', async (request, reply) => {
    const projectId = request.projectId;
    let project;
    try {
      const dbRow = await projectsQ.getById(getDb(), projectId);
      project = getProject(config, projectId, dbRow ?? undefined);
    } catch {
      return reply.badRequest(`Unknown project: "${projectId}"`);
    }

    const bareRepo = project.bareRepoPath;
    if (!bareRepo) {
      return reply.code(422).send({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'bareRepoPath is not configured',
      });
    }

    const exteriorRepo = project.path;
    if (!exteriorRepo) {
      return reply.code(422).send({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'project.path is not configured',
      });
    }

    const seedBranch = seedBranchFor(projectId, project);

    const syncResult = syncExteriorToBareRepo(exteriorRepo, bareRepo, seedBranch, fastify.log);

    if (!syncResult.ok) {
      return reply.code(409).send({
        ok: false,
        reason: syncResult.reason,
      });
    }

    const { exteriorHead, commitSha } = syncResult;

    // Optionally merge seed branch into agent branches
    const { targetAgents } = request.body ?? {};
    const mergedAgents: string[] = [];
    const failedMerges: Array<{ agent: string; reason: string }> = [];

    if (targetAgents) {
      let agentNames: string[];
      if (targetAgents === '*') {
        agentNames = await agentsQ.getActiveNames(getDb());
      } else if (Array.isArray(targetAgents)) {
        agentNames = targetAgents;
      } else {
        return reply.badRequest('targetAgents must be an array of agent names or "*"');
      }

      for (const agentName of agentNames) {
        if (typeof agentName !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(agentName)) {
          return reply.badRequest(`Invalid agent name in targetAgents: "${String(agentName).slice(0, 64)}"`);
        }
        const targetBranch = agentBranchFor(projectId, agentName);
        const result = mergeIntoBranch(bareRepo, seedBranch, targetBranch);
        if (result.ok) {
          mergedAgents.push(agentName);
        } else {
          failedMerges.push({ agent: agentName, reason: result.reason });
        }
      }
    }

    return {
      ok: true,
      exteriorHead,
      ...(commitSha ? { commitSha } : { upToDate: true }),
      ...(mergedAgents.length ? { mergedAgents } : {}),
      ...(failedMerges.length ? { failedMerges } : {}),
    };
  });
};

export default syncPlugin;
