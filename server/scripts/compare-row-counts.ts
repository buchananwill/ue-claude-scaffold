/**
 * Throwaway: per-table row-count parity check between a PGlite source and
 * a Postgres target.
 *
 * Usage:
 *   SCAFFOLD_DATABASE_URL=... npx tsx scripts/compare-row-counts.ts <pglite-dir>
 */
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { TABLES } from "./copy-pglite-to-postgres.js";

const dir = process.argv[2] ?? "./server/data/pglite";
const url = process.env.SCAFFOLD_DATABASE_URL;
if (!url) {
  console.error("SCAFFOLD_DATABASE_URL not set");
  process.exit(1);
}

const pglite = new PGlite(dir);
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  let allMatch = true;
  console.log(
    "table".padEnd(22),
    "pglite".padStart(10),
    "postgres".padStart(10),
    "ok",
  );
  for (const t of TABLES) {
    const [src, dst] = await Promise.all([
      pglite.query(`SELECT count(*)::int AS c FROM "${t.name}"`),
      pool.query(`SELECT count(*)::int AS c FROM "${t.name}"`),
    ]);
    const s = (src.rows[0] as { c: number }).c;
    const d = (dst.rows[0] as { c: number }).c;
    const match = s === d;
    if (!match) allMatch = false;
    console.log(
      t.name.padEnd(22),
      String(s).padStart(10),
      String(d).padStart(10),
      match ? "✓" : "✗ MISMATCH",
    );
  }
  console.log(
    allMatch ? "\nOK: all 15 tables match" : "\nFAIL: counts diverge",
  );
  if (!allMatch) process.exit(1);
} finally {
  await pglite.close();
  await pool.end();
}
