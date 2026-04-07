import type { FastifyPluginAsync } from 'fastify';
import type { ScaffoldConfig } from '../config.js';
import { resolveProjectConfig } from '../config-resolver.js';

interface ConfigOpts {
  config: ScaffoldConfig;
}

const configPlugin: FastifyPluginAsync<ConfigOpts> = async (app, { config }) => {
  /**
   * GET /config — list all project IDs known to the config.
   */
  app.get('/config', async () => {
    return {
      projectIds: Object.keys(config.resolvedProjects),
    };
  });

  /**
   * GET /config/:projectId — return the fully resolved config for a project.
   */
  app.get<{ Params: { projectId: string } }>('/config/:projectId', {
    schema: {
      params: {
        type: 'object',
        properties: { projectId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' } },
        required: ['projectId'],
      },
    },
  }, async (request, reply) => {
    const { projectId } = request.params;
    try {
      const resolved = resolveProjectConfig(projectId, config);
      return resolved;
    } catch (err) {
      request.log.warn(err, 'resolveProjectConfig failed');
      // If the error is not about an unknown project, let Fastify's default
      // error handler return 500 instead of masking it as 404.
      if (err instanceof Error && /Unknown project/.test(err.message)) {
        return reply.notFound('Project not found');
      }
      throw err;
    }
  });
};

export default configPlugin;
