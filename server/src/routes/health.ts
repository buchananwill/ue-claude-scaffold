import type { FastifyPluginAsync } from 'fastify';
import type { ScaffoldConfig } from '../config.js';
import { getDbStatus } from '../drizzle-instance.js';

interface HealthOpts {
  config: ScaffoldConfig;
  pgliteDataDir?: string;
}

const healthPlugin: FastifyPluginAsync<HealthOpts> = async (fastify, opts) => {
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      db: getDbStatus(),
      config: {
        port: opts.config.server.port,
        projectName: opts.config.project.name,
        ubtLockTimeoutMs: opts.config.server.ubtLockTimeoutMs,
      },
    };
  });
};

export default healthPlugin;
