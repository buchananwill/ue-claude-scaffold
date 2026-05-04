/**
 * Throwaway: confirm jsonb scalar-string values came through the cutover intact.
 */
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

const dir = process.argv[2] ?? "./server/data/pglite";
const url = process.env.SCAFFOLD_DATABASE_URL;
if (!url) throw new Error("SCAFFOLD_DATABASE_URL not set");

const pglite = new PGlite(dir);
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  // Find tasks where result is a JSON string (jsonb_typeof = 'string').
  const sourceStrings = await pglite.query(
    `SELECT id, result FROM tasks WHERE jsonb_typeof(result) = 'string' ORDER BY id`,
  );
  console.log(
    `source: ${sourceStrings.rows.length} tasks with jsonb-string result`,
  );
  for (const r of sourceStrings.rows as Array<{
    id: number;
    result: unknown;
  }>) {
    const tgt = await pool.query(`SELECT result FROM tasks WHERE id = $1`, [
      r.id,
    ]);
    const tgtVal = (tgt.rows[0] as { result: unknown }).result;
    const match = tgtVal === r.result;
    console.log(
      `  task ${r.id}: ${match ? "✓" : "✗"} (source: ${typeof r.result}, target: ${typeof tgtVal})`,
    );
    if (!match) {
      console.log("    source:", JSON.stringify(r.result).slice(0, 80));
      console.log("    target:", JSON.stringify(tgtVal).slice(0, 80));
    }
  }
} finally {
  await pglite.close();
  await pool.end();
}
