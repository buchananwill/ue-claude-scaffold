/**
 * Drizzle-aware test helper for route tests during the migration period.
 *
 * Creates a PGlite in-memory instance with the full schema, patches the
 * Drizzle singleton so getDb() works, and returns a Fastify app with
 * @fastify/sensible and the project-id plugin pre-registered.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { DrizzleDb } from './drizzle-instance.js';
import { _setInstanceForTest } from './drizzle-instance.js';
import projectIdPlugin from './plugins/project-id.js';
import { createTestDb as createQueryTestDb } from './queries/test-utils.js';

export interface DrizzleTestContext {
  app: FastifyInstance;
  db: DrizzleDb;
  cleanup: () => Promise<void>;
}

export async function createDrizzleTestApp(): Promise<DrizzleTestContext> {
  const testDb = await createQueryTestDb();

  // Patch the singleton so getDb() returns our test DB
  const restore = _setInstanceForTest(testDb.db);

  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(projectIdPlugin);

  const cleanup = async () => {
    restore();
    await testDb.close();
  };

  return { app, db: testDb.db, cleanup };
}
