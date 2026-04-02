import type { FastifyPluginAsync } from 'fastify';
import type { ScaffoldConfig } from '../config.js';
import { getProject } from '../config.js';
import { syncExteriorToBareRepo, mergeIntoBranch } from '../git-utils.js';
import { getDb } from '../drizzle-instance.js';
import * as agentsQ from '../queries/agents.js';

interface SyncOpts {
  config: ScaffoldConfig;
}

const syncPlugin: FastifyPluginAsync<SyncOpts> = async (fastify, opts) => {
  const { config } = opts;

  // POST /sync/plans — merge committed state from exterior repo into bare repo's plan branch.
  // The exterior repo (config.project.path) is the source of truth for plans.
  // This endpoint fetches its HEAD into a temp branch, merges into docker/current-root,
  // and optionally propagates to agent branches.
  fastify.post<{
    Body: { targetAgents?: string[] | string };
  }>('/sync/plans', async (request, reply) => {
    const projectId = (request.headers['x-project-id'] as string) || 'default';
    let project;
    try {
      project = getProject(config, projectId);
    } catch {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `Unknown project: "${projectId}"`,
      });
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

    const planBranch = project.planBranch ?? config.tasks?.planBranch ?? 'docker/current-root';

    const syncResult = syncExteriorToBareRepo(exteriorRepo, bareRepo, planBranch, fastify.log);

    if (!syncResult.ok) {
      return reply.code(409).send({
        ok: false,
        reason: syncResult.reason,
      });
    }

    const { exteriorHead, commitSha } = syncResult;

    // Optionally merge plan branch into agent branches
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
        const targetBranch = `docker/${agentName}`;
        const result = mergeIntoBranch(bareRepo, planBranch, targetBranch);
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
