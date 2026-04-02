import type { FastifyPluginAsync } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    projectId: string;
  }
}

const projectIdPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('projectId', 'default');
  fastify.addHook('preHandler', async (request) => {
    const raw = (request.headers['x-project-id'] as string) || 'default';
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(raw)) {
      throw fastify.httpErrors.badRequest(`Invalid project ID: "${raw}"`);
    }
    request.projectId = raw;
  });
};
export default projectIdPlugin;
