import type { FastifyPluginAsync } from 'fastify';
import type { ScaffoldConfig } from '../config.js';

interface HealthOpts {
  config: ScaffoldConfig;
  pgliteDataDir?: string;
}

const healthPlugin: FastifyPluginAsync<HealthOpts> = async (fastify, opts) => {
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      db: `PGlite (${opts.pgliteDataDir ?? 'in-memory'})`,
      config: {
        port: opts.config.server.port,
        projectName: opts.config.project.name,
        ubtLockTimeoutMs: opts.config.server.ubtLockTimeoutMs,
      },
    };
  });
};

export default healthPlugin;
