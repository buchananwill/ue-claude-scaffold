import type { FastifyPluginAsync } from 'fastify';
import type { ProjectRow } from '../queries/projects.js';

declare module 'fastify' {
  interface FastifyRequest {
    projectId: string;
    /** Portable project record from DB, if it exists */
    projectRecord: ProjectRow | null;
  }
}

const projectIdPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('projectId', 'default');
  fastify.decorateRequest('projectRecord', null);
  fastify.addHook('preHandler', async (request) => {
    const raw = (request.headers['x-project-id'] as string) || 'default';
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(raw)) {
      throw fastify.httpErrors.badRequest(`Invalid project ID: "${raw}"`);
    }
    request.projectId = raw;
  });
};
export default projectIdPlugin;
