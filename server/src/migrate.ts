/**
 * Standalone migration runner.
 *
 * Usage:
 *   SCAFFOLD_DATABASE_URL=postgresql://... npx tsx src/migrate.ts
 *
 * For PGlite (local dev), omit SCAFFOLD_DATABASE_URL and pass an optional data dir:
 *   npx tsx src/migrate.ts [pglite-data-dir]
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { applyScaffoldDatabaseUrl } from "./db-env.js";
import { initDrizzle, closeDrizzle, getDbStatus } from "./drizzle-instance.js";

applyScaffoldDatabaseUrl();

const pgliteDataDir = process.argv[2] || undefined;

const db = await initDrizzle({ pgliteDataDir });
const status = getDbStatus();

console.log(`Running migrations against ${status.backend}…`);

if (status.backend === "postgres") {
  await migrate(db as Parameters<typeof migrate>[0], {
    migrationsFolder: "./drizzle",
  });
} else {
  await migratePglite(db as Parameters<typeof migratePglite>[0], {
    migrationsFolder: "./drizzle",
  });
}

console.log("Migrations applied successfully.");
await closeDrizzle();
