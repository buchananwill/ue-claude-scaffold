import type { FastifyPluginAsync } from 'fastify';
import type { ScaffoldConfig } from '../config.js';
import { syncExteriorToBareRepo, mergeIntoAgentBranches } from '../git-utils.js';
import { getDb } from '../drizzle-instance.js';
import { seedBranchFor, AGENT_NAME_RE } from '../branch-naming.js';
import { resolveProject } from '../resolve-project.js';

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
      project = await resolveProject(config, getDb(), projectId);
    } catch {
      return reply.badRequest(`Unknown project: "${projectId}"`);
    }

    const bareRepo = project.bareRepoPath;
    if (!bareRepo) {
      return reply.unprocessableEntity('bareRepoPath is not configured');
    }

    const exteriorRepo = project.path;
    if (!exteriorRepo) {
      return reply.unprocessableEntity('project.path is not configured');
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
    let mergedAgents: string[] = [];
    let failedMerges: Array<{ agent: string; reason: string }> = [];

    if (targetAgents) {
      if (targetAgents !== '*' && !Array.isArray(targetAgents)) {
        return reply.badRequest('targetAgents must be an array of agent names or "*"');
      }

      // Validate names if explicit array
      if (Array.isArray(targetAgents)) {
        for (const agentName of targetAgents) {
          if (typeof agentName !== 'string' || !AGENT_NAME_RE.test(agentName)) {
            return reply.badRequest(`Invalid agent name in targetAgents: "${String(agentName).slice(0, 64)}"`);
          }
        }
      }

      const db = getDb();
      const mergeResult = await mergeIntoAgentBranches({
        bareRepo, projectId, project, targetAgents, db, log: fastify.log,
      });
      mergedAgents = mergeResult.mergedAgents;
      failedMerges = mergeResult.failedMerges;
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
