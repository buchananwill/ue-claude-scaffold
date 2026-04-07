import type { FastifyPluginAsync } from 'fastify';
import type { ScaffoldConfig } from '../config.js';
import { resolveProjectConfig } from '../config-resolver.js';

interface ConfigOpts {
  config: ScaffoldConfig;
}

const configPlugin: FastifyPluginAsync<ConfigOpts> = async (fastify, opts) => {
  /**
   * GET /config — list all project IDs known to the config.
   */
  fastify.get('/config', async () => {
    return {
      projectIds: Object.keys(opts.config.resolvedProjects),
    };
  });

  /**
   * GET /config/:projectId — return the fully resolved config for a project.
   */
  fastify.get<{ Params: { projectId: string } }>('/config/:projectId', async (request, reply) => {
    const { projectId } = request.params;
    try {
      const resolved = resolveProjectConfig(projectId, opts.config);
      return resolved;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.notFound(message);
    }
  });
};

export default configPlugin;
