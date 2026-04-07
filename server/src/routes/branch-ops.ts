import type { FastifyPluginAsync } from 'fastify';
import type { ScaffoldConfig } from '../config.js';
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
        properties: {
          name: { type: 'string', pattern: AGENT_NAME_RE.source },
        },
      },
      body: {
        type: 'object',
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

    let project;
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
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message,
      });
    }
  });

  /**
   * POST /projects/:id/seed:bootstrap
   * Bootstrap a bare repo from a project path and create the seed branch.
   */
  fastify.post<{
    Params: { id: string };
    Body: { projectPath: string };
  }>('/projects/:id/seed:bootstrap', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', pattern: PROJECT_ID_RE.source },
        },
      },
      body: {
        type: 'object',
        required: ['projectPath'],
        properties: {
          projectPath: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { projectPath } = request.body;
    const db = getDb();

    let project;
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

    try {
      const result = bootstrapBareRepo({
        bareRepoPath,
        projectPath,
        projectId: id,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message,
      });
    }
  });
};

export default branchOpsPlugin;
