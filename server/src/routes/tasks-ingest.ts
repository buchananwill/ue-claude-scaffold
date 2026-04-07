import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { ScaffoldConfig } from '../config.js';
import { getDb } from '../drizzle-instance.js';
import { ingestTaskDir } from '../task-ingest.js';

interface IngestOpts {
  config: ScaffoldConfig;
}

interface IngestBody {
  tasksDir: string;
}

const bodySchema = {
  type: 'object',
  required: ['tasksDir'],
  properties: {
    tasksDir: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const;

const tasksIngestPlugin: FastifyPluginAsync<IngestOpts> = async (fastify, { config }) => {
  const db = getDb();

  fastify.post<{ Body: IngestBody }>('/tasks/ingest', {
    schema: { body: bodySchema },
  }, async (request, reply) => {
    const { tasksDir } = request.body;
    const projectId = request.projectId;

    // Require absolute path — eliminates need for relative-path traversal checks
    if (!path.isAbsolute(tasksDir)) {
      return reply.badRequest('tasksDir must be an absolute path');
    }

    // Resolve and validate against configured project paths
    const resolved = path.resolve(tasksDir);
    const allowedRoots = Object.values(config.resolvedProjects)
      .map((p) => path.resolve(p.path))
      .filter((r) => r.length > 0);
    if (allowedRoots.length === 0) {
      return reply.badRequest('No project paths configured on this server');
    }
    const isAllowed = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
    if (!isAllowed) {
      return reply.badRequest('tasksDir is not within any configured project path');
    }

    try {
      const result = await ingestTaskDir(db, resolved, projectId);
      return result;
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.badRequest('tasksDir not found or not accessible');
      }
      // Sanitize error — do not leak filesystem paths
      request.log.error(err, 'task ingest failed');
      return reply.badRequest('Failed to ingest tasks');
    }
  });
};

export default tasksIngestPlugin;
