import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { loadConfig } from './config.js';
import { initDrizzle } from './drizzle-instance.js';
import projectIdPlugin from './plugins/project-id.js';
import {
  healthPlugin,
  agentsPlugin,
  messagesPlugin,
  ubtPlugin,
  buildPlugin,
  tasksPlugin,
  filesPlugin,
  searchPlugin,
  buildsPlugin,
  coalescePlugin,
  syncPlugin,
  roomsPlugin,
  teamsPlugin,
} from './routes/index.js';
import { sweepStaleLock } from './routes/ubt.js';

const config = loadConfig();
const pgliteDataDir = './data/pglite';
await initDrizzle({ pgliteDataDir });

const server = Fastify({
  logger: true,
  requestTimeout: 0,
});

await server.register(sensible);
await server.register(projectIdPlugin);
await server.register(healthPlugin, { config, pgliteDataDir });
await server.register(agentsPlugin, { config });
await server.register(messagesPlugin);
await server.register(ubtPlugin, { config });
await server.register(buildPlugin, { config });
await server.register(tasksPlugin, { config });
await server.register(filesPlugin);
await server.register(searchPlugin);
await server.register(buildsPlugin);
await server.register(coalescePlugin);
await server.register(syncPlugin, { config });
await server.register(roomsPlugin);
await server.register(teamsPlugin);

try {
  const address = await server.listen({
    port: config.server.port,
    host: '0.0.0.0',
  });
  console.log(`Coordination server listening at ${address}`);
  console.log(`  Project: ${config.project.name}`);
  console.log(`  DB: PGlite (${pgliteDataDir})`);
  console.log(`  UBT lock timeout: ${config.server.ubtLockTimeoutMs}ms`);

  setInterval(() => {
    sweepStaleLock().catch((err) => {
      server.log.error(err, 'UBT stale-lock sweep failed');
    });
  }, 60_000);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
