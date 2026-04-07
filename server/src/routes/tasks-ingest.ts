import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import { ingestTaskDir } from '../task-ingest.js';

interface IngestBody {
  tasksDir: string;
  projectId?: string;
}

const bodySchema = {
  type: 'object',
  required: ['tasksDir'],
  properties: {
    tasksDir: { type: 'string', minLength: 1 },
    projectId: { type: 'string' },
  },
  additionalProperties: false,
} as const;

const tasksIngestPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: IngestBody }>('/tasks/ingest', {
    schema: { body: bodySchema },
  }, async (request, reply) => {
    const { tasksDir, projectId: bodyProjectId } = request.body;

    // Path traversal check
    if (tasksDir.includes('..')) {
      return reply.badRequest('tasksDir must not contain path traversal (..)');
    }

    const projectId = bodyProjectId ?? request.projectId;
    const db = getDb();

    const result = await ingestTaskDir(db, tasksDir, projectId);
    return result;
  });
};

export default tasksIngestPlugin;
