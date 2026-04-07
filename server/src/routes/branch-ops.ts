import type { FastifyPluginAsync } from 'fastify';
import type { ScaffoldConfig, MergedProjectConfig } from '../config.js';
import { resolveProject } from '../resolve-project.js';
import { getDb } from '../drizzle-instance.js';
import { AGENT_NAME_RE, PROJECT_ID_RE } from '../branch-naming.js';
import { ensureAgentBranch, bootstrapBareRepo } from '../branch-ops.js';

interface BranchOpsOpts {
  config: ScaffoldConfig;
}

const branchOpsPlugin: FastifyPluginAsync<BranchOpsOpts> = async (fastify, { config }) => {
  /**
   * POST /agents/:name/branch
   * Ensure an agent branch exists (create, reset, or resume).
   */
  fastify.post<{
    Params: { name: string };
    Body: { fresh?: boolean };
  }>('/agents/:name/branch', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', pattern: AGENT_NAME_RE.source },
        },
      },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fresh: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params;
    const { fresh = false } = request.body ?? {};
    const projectId = request.projectId;
    const db = getDb();

    let project: MergedProjectConfig;
    try {
      project = await resolveProject(config, db, projectId);
    } catch {
      return reply.badRequest(`Unknown project: "${projectId}"`);
    }

    const bareRepoPath = project.bareRepoPath;
    if (!bareRepoPath) {
      return reply.code(422).send({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'Branch operations require bareRepoPath to be configured',
      });
    }

    try {
      const result = ensureAgentBranch({
        bareRepoPath,
        projectId,
        agentName: name,
        fresh,
        seedBranch: project.seedBranch,
      });
      return result;
    } catch (err) {
      request.log.error(err, 'Branch operation failed');
      return reply.internalServerError('Branch operation failed');
    }
  });

  /**
   * POST /projects/:id/seed/bootstrap
   * Bootstrap a bare repo from a project path and create the seed branch.
   *
   * This endpoint is internal to the Docker network. No authentication is
   * enforced — the server relies on network isolation.
   */
  fastify.post<{
    Params: { id: string };
  }>('/projects/:id/seed/bootstrap', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: PROJECT_ID_RE.source },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    let project: MergedProjectConfig;
    try {
      project = await resolveProject(config, db, id);
    } catch {
      return reply.badRequest(`Unknown project: "${id}"`);
    }

    const bareRepoPath = project.bareRepoPath;
    if (!bareRepoPath) {
      return reply.code(422).send({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'Bootstrap requires bareRepoPath to be configured',
      });
    }

    const projectPath = project.path;
    if (!projectPath) {
      return reply.badRequest('Project path is not configured');
    }

    try {
      const result = bootstrapBareRepo({
        bareRepoPath,
        projectPath,
        projectId: id,
        seedBranch: project.seedBranch,
      });
      return result;
    } catch (err) {
      request.log.error(err, 'Branch operation failed');
      return reply.internalServerError('Branch operation failed');
    }
  });
};

export default branchOpsPlugin;
