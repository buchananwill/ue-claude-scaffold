import type { FastifyPluginAsync } from 'fastify';
import { resolveHooks, type HookResolutionInput } from '../hook-resolution.js';
import { isValidProjectId } from '../branch-naming.js';

const hooksPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: HookResolutionInput;
  }>('/hooks/resolve', async (request, reply) => {
    const body = request.body;

    if (!body || typeof body !== 'object') {
      return reply.badRequest('Request body is required');
    }

    if (!body.projectId || typeof body.projectId !== 'string') {
      return reply.badRequest('projectId is required');
    }

    if (!isValidProjectId(body.projectId)) {
      return reply.badRequest('Invalid projectId format');
    }

    if (typeof body.hasBuildScript !== 'boolean') {
      return reply.badRequest('hasBuildScript (boolean) is required');
    }

    return resolveHooks(body);
  });
};

export default hooksPlugin;
