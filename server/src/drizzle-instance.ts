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
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import * as schema from './schema/index.js';

export type DrizzleDb = ReturnType<typeof drizzlePg<typeof schema>> | ReturnType<typeof drizzlePglite<typeof schema>>;

let instance: DrizzleDb | null = null;
let pgliteClient: PGlite | null = null;

export interface InitDrizzleOpts {
  /** Postgres connection string. Falls back to process.env.DATABASE_URL. */
  databaseUrl?: string;
  /** For PGlite: path to on-disk directory, or omit for in-memory. */
  pgliteDataDir?: string;
}

/**
 * Initialise the Drizzle instance. Safe to call multiple times — returns the
 * existing instance if already initialised.
 */
export async function initDrizzle(opts?: InitDrizzleOpts): Promise<DrizzleDb> {
  if (instance) return instance;

  const databaseUrl = opts?.databaseUrl ?? process.env.DATABASE_URL;

  if (databaseUrl) {
    // Production: node-postgres
    const pool = new pg.Pool({ connectionString: databaseUrl });
    instance = drizzlePg(pool, { schema });
  } else {
    // Local / test: PGlite (in-process Postgres)
    const dataDir = opts?.pgliteDataDir; // undefined = in-memory
    pgliteClient = new PGlite(dataDir);
    instance = drizzlePglite(pgliteClient, { schema });
  }

  return instance;
}

/** Return the initialised Drizzle instance. Throws if not yet initialised. */
export function getDb(): DrizzleDb {
  if (!instance) {
    throw new Error('Drizzle not initialised — call initDrizzle() first');
  }
  return instance;
}

/** Tear down the connection (useful in tests). */
export async function closeDrizzle(): Promise<void> {
  if (pgliteClient) {
    await pgliteClient.close();
    pgliteClient = null;
  }
  instance = null;
}
