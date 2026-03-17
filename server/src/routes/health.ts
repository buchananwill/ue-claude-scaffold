import type { FastifyPluginAsync } from 'fastify';
import type { ScaffoldConfig } from '../config.js';

interface HealthOpts {
  dbPath: string;
  config: ScaffoldConfig;
}

const healthPlugin: FastifyPluginAsync<HealthOpts> = async (fastify, opts) => {
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      dbPath: opts.dbPath,
      config: {
        port: opts.config.server.port,
        projectName: opts.config.project.name,
        ubtLockTimeoutMs: opts.config.server.ubtLockTimeoutMs,
      },
    };
  });
};

export default healthPlugin;
