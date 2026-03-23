import type { FastifyPluginAsync } from 'fastify';
import { execFileSync } from 'node:child_process';
import type { ScaffoldConfig } from '../config.js';
import { mergeIntoBranch } from '../git-utils.js';
import { db } from '../db.js';

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
    const bareRepo = config.server.bareRepoPath;
    if (!bareRepo) {
      return reply.code(422).send({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'server.bareRepoPath is not configured',
      });
    }

    const exteriorRepo = config.project.path;
    if (!exteriorRepo) {
      return reply.code(422).send({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'project.path is not configured',
      });
    }

    const planBranch = config.tasks?.planBranch ?? 'docker/current-root';
    const tempRef = '_sync/exterior';

    // Step 1: Resolve exterior repo's HEAD
    let exteriorHead: string;
    try {
      exteriorHead = execFileSync('git', ['-C', exteriorRepo, 'rev-parse', 'HEAD'], {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
    } catch (err: any) {
      return reply.code(422).send({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: `Failed to resolve HEAD in exterior repo: ${err.message}`,
      });
    }

    // Step 2: Fetch exterior HEAD into a temp branch in the bare repo
    try {
      execFileSync('git', [
        '-C', bareRepo, 'fetch', exteriorRepo,
        `+${exteriorHead}:refs/heads/${tempRef}`,
      ], { timeout: 30_000 });
    } catch (err: any) {
      return reply.code(422).send({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: `Failed to fetch from exterior repo: ${err.message}`,
      });
    }

    // Step 3: Merge temp branch into plan branch
    let mergeResult: ReturnType<typeof mergeIntoBranch>;
    try {
      mergeResult = mergeIntoBranch(bareRepo, tempRef, planBranch);
    } finally {
      // Clean up temp branch regardless of outcome
      try {
        execFileSync('git', ['-C', bareRepo, 'update-ref', '-d', `refs/heads/${tempRef}`], {
          timeout: 5000,
        });
      } catch { /* best effort */ }
    }

    if (!mergeResult.ok) {
      return reply.code(409).send({
        ok: false,
        exteriorHead,
        reason: mergeResult.reason,
      });
    }

    // Step 4: Optionally merge plan branch into agent branches
    const { targetAgents } = request.body ?? {};
    const mergedAgents: string[] = [];
    const failedMerges: Array<{ agent: string; reason: string }> = [];

    if (targetAgents) {
      let agentNames: string[];
      if (targetAgents === '*') {
        const activeAgents = db.prepare(
          "SELECT name FROM agents WHERE status NOT IN ('done', 'error')"
        ).all() as Array<{ name: string }>;
        agentNames = activeAgents.map(a => a.name);
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
      ...(mergeResult.commitSha ? { commitSha: mergeResult.commitSha } : { upToDate: true }),
      ...(mergedAgents.length ? { mergedAgents } : {}),
      ...(failedMerges.length ? { failedMerges } : {}),
    };
  });
};

export default syncPlugin;
