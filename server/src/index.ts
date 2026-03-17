import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import {
  healthPlugin,
  agentsPlugin,
  messagesPlugin,
  ubtPlugin,
  buildPlugin,
  tasksPlugin,
} from './routes/index.js';
import { sweepStaleLock } from './routes/ubt.js';

const __dirname = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

const config = loadConfig();
const dbPath = path.join(__dirname, '..', 'coordination.db');
openDb(dbPath);

const server = Fastify({
  logger: true,
  requestTimeout: 0,
});

await server.register(sensible);
await server.register(healthPlugin, { dbPath, config });
await server.register(agentsPlugin);
await server.register(messagesPlugin);
await server.register(ubtPlugin, { config });
await server.register(buildPlugin, { config });
await server.register(tasksPlugin);

try {
  const address = await server.listen({
    port: config.server.port,
    host: '0.0.0.0',
  });
  console.log(`Coordination server listening at ${address}`);
  console.log(`  Project: ${config.project.name}`);
  console.log(`  DB path: ${dbPath}`);
  console.log(`  UBT lock timeout: ${config.server.ubtLockTimeoutMs}ms`);

  setInterval(() => {
    try {
      sweepStaleLock();
    } catch (err) {
      server.log.error(err, 'UBT stale-lock sweep failed');
    }
  }, 60_000);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
