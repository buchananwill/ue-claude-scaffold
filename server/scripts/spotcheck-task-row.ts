/**
 * Throwaway: deep column-by-column equality check on a single tasks row,
 * per Phase 5 verification step.
 */
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import assert from "node:assert/strict";

const dir = process.argv[2] ?? "./server/data/pglite";
const url = process.env.SCAFFOLD_DATABASE_URL;
if (!url) throw new Error("SCAFFOLD_DATABASE_URL not set");

const pglite = new PGlite(dir);
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  // Pick a row with non-null acceptance_criteria, jsonb object result, and an
  // agent_type_override — exercises the most schema features in one row.
  const candidate = await pglite.query(
    `SELECT id FROM tasks
     WHERE acceptance_criteria IS NOT NULL
       AND result IS NOT NULL
       AND jsonb_typeof(result) = 'object'
       AND agent_type_override IS NOT NULL
     ORDER BY id
     LIMIT 1`,
  );
  if (candidate.rows.length === 0) {
    console.log(
      "no candidate row with all features — falling back to any non-null row",
    );
    const fallback = await pglite.query(
      `SELECT id FROM tasks WHERE result IS NOT NULL ORDER BY id LIMIT 1`,
    );
    if (fallback.rows.length === 0)
      throw new Error("no tasks rows to spot-check");
    (candidate.rows as Array<{ id: number }>)[0] = (
      fallback.rows as Array<{ id: number }>
    )[0];
  }
  const id = (candidate.rows[0] as { id: number }).id;
  console.log(`spot-checking task id=${id}`);

  const [src, dst] = await Promise.all([
    pglite.query(`SELECT * FROM tasks WHERE id = $1`, [id]),
    pool.query(`SELECT * FROM tasks WHERE id = $1`, [id]),
  ]);

  const s = src.rows[0] as Record<string, unknown>;
  const d = dst.rows[0] as Record<string, unknown>;

  let mismatches = 0;
  const cols = Object.keys(s);
  for (const c of cols) {
    let sv = s[c];
    let dv = d[c];
    // Normalize Date objects to ISO strings for comparison (timezone equiv).
    if (sv instanceof Date) sv = sv.toISOString();
    if (dv instanceof Date) dv = dv.toISOString();
    try {
      assert.deepEqual(dv, sv);
      console.log(`  ${c}: ✓`);
    } catch {
      mismatches++;
      console.log(`  ${c}: ✗`);
      console.log(`    source: ${JSON.stringify(sv)?.slice(0, 120)}`);
      console.log(`    target: ${JSON.stringify(dv)?.slice(0, 120)}`);
    }
  }
  console.log(
    mismatches === 0
      ? `\nOK: ${cols.length} columns match`
      : `\nFAIL: ${mismatches} mismatch(es)`,
  );
  if (mismatches > 0) process.exit(1);
} finally {
  await pglite.close();
  await pool.end();
}
