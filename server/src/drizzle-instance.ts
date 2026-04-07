/**
 * Drizzle ORM driver factory.
 *
 * - When DATABASE_URL is set, connects via node-postgres (production).
 * - Otherwise, spins up an in-process PGlite instance (local dev / tests).
 *
 * Schema is applied via push (raw SQL from drizzle-kit generate output) or
 * drizzle-orm migrate() when migration files exist.
 */

import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { mkdirSync } from 'node:fs';
import * as schema from './schema/index.js';

/** Full database instance (PGlite or node-postgres). */
export type DrizzlePgDb = ReturnType<typeof drizzlePg<typeof schema>>;
export type DrizzlePgliteDb = ReturnType<typeof drizzlePglite<typeof schema>>;
export type DrizzleDb = DrizzlePgDb | DrizzlePgliteDb;

/** Transaction client type — the `tx` passed to `.transaction()` callbacks. */
export type DrizzleTx =
  | Parameters<Parameters<DrizzlePgDb['transaction']>[0]>[0]
  | Parameters<Parameters<DrizzlePgliteDb['transaction']>[0]>[0];

let instance: DrizzleDb | null = null;
let pgliteClient: PGlite | null = null;
let pgPool: pg.Pool | null = null;
let initPromise: Promise<DrizzleDb> | null = null;

export interface InitDrizzleOpts {
  /** Postgres connection string. Falls back to process.env.DATABASE_URL. */
  databaseUrl?: string;
  /** For PGlite: path to on-disk directory, or omit for in-memory. */
  pgliteDataDir?: string;
}

async function doInit(opts?: InitDrizzleOpts): Promise<DrizzleDb> {
  const databaseUrl = opts?.databaseUrl ?? process.env.DATABASE_URL;

  if (databaseUrl) {
    // Production: node-postgres
    pgPool = new pg.Pool({
      connectionString: databaseUrl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pgPool.on('error', (err) => {
      console.error('[drizzle] pg pool idle client error', err);
    });
    instance = drizzlePg(pgPool, { schema });
    await migratePg(instance, { migrationsFolder: './drizzle' });
  } else {
    // Local / test: PGlite (in-process Postgres)
    const dataDir = opts?.pgliteDataDir; // undefined = in-memory
    if (dataDir) {
      mkdirSync(dataDir, { recursive: true });
    }
    pgliteClient = new PGlite(dataDir);
    instance = drizzlePglite(pgliteClient, { schema });
    // Set timezone to UTC so DEFAULT now() and all timestamps are in UTC
    await (instance as any).execute('SET timezone TO \'UTC\'');
    await migratePglite(instance as Parameters<typeof migratePglite>[0], { migrationsFolder: './drizzle' });
  }

  return instance;
}

/**
 * Initialise the Drizzle instance. Safe to call multiple times — returns the
 * existing instance if already initialised. Guards against concurrent calls.
 */
export function initDrizzle(opts?: InitDrizzleOpts): Promise<DrizzleDb> {
  if (instance) return Promise.resolve(instance);
  if (initPromise) return initPromise;
  initPromise = doInit(opts).catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

/** Return the initialised Drizzle instance. Throws if not yet initialised. */
export function getDb(): DrizzleDb {
  if (!instance) {
    throw new Error('Drizzle not initialised — call initDrizzle() first');
  }
  return instance;
}

/** Return the Drizzle instance, or null if not yet initialised. */
export function tryGetDb(): DrizzleDb | null {
  return instance;
}

/**
 * Replace the singleton instance (test-only).
 * Returns a restore function that puts the previous value back.
 */
export function _setInstanceForTest(db: DrizzleDb): () => void {
  const prev = instance;
  instance = db;
  return () => { instance = prev; };
}

/** Return status info about the DB backend (for /health). */
export function getDbStatus(): { backend: string; pool?: { total: number; idle: number; waiting: number } } {
  if (pgPool) {
    return {
      backend: 'postgres',
      pool: {
        total: pgPool.totalCount,
        idle: pgPool.idleCount,
        waiting: pgPool.waitingCount,
      },
    };
  }
  return { backend: 'pglite' };
}

/** Tear down the connection (useful in tests). */
export async function closeDrizzle(): Promise<void> {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
  if (pgliteClient) {
    await pgliteClient.close();
    pgliteClient = null;
  }
  instance = null;
  initPromise = null;
}
