import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyRequest {
    projectId: string;
  }
}

const projectIdPluginInner: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('projectId', 'default');
  fastify.addHook('preHandler', async (request) => {
    const rawHeader = request.headers['x-project-id'];
    const raw = Array.isArray(rawHeader) ? rawHeader[0] : (rawHeader ?? 'default');
    // Format-only validation; DB existence is checked at the route level, not here,
    // to avoid per-request DB queries for endpoints that may not need it.
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(raw)) {
      throw fastify.httpErrors.badRequest(`Invalid project ID: "${raw}"`);
    }
    request.projectId = raw;
  });
};

const projectIdPlugin = fp(projectIdPluginInner, {
  name: 'project-id',
});
export default projectIdPlugin;
