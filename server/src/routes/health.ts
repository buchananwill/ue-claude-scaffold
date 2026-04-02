import type { FastifyPluginAsync } from 'fastify';
import type { ScaffoldConfig } from '../config.js';
import { getDb, getDbStatus } from '../drizzle-instance.js';
import * as projectsQ from '../queries/projects.js';

interface HealthOpts {
  config: ScaffoldConfig;
  pgliteDataDir?: string;
}

const healthPlugin: FastifyPluginAsync<HealthOpts> = async (fastify, opts) => {
  fastify.get('/health', async (request) => {
    const projectId = (request.headers['x-project-id'] as string) || undefined;
    let projectName: string | undefined;

    if (projectId) {
      const db = getDb();
      const project = await projectsQ.getById(db, projectId);
      projectName = project?.name;
    }

    return {
      status: 'ok',
      db: getDbStatus(),
      config: {
        port: opts.config.server.port,
        ubtLockTimeoutMs: opts.config.server.ubtLockTimeoutMs,
        ...(projectName ? { projectName } : {}),
      },
    };
  });
};

export default healthPlugin;
