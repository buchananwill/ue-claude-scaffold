/**
 * One-shot verification that the new Supabase target has the full schema applied
 * and is empty. Throwaway — not part of the long-term toolset.
 *
 * Usage:
 *   SCAFFOLD_DATABASE_URL=... npx tsx scripts/verify-supabase-schema.ts
 */
import pg from "pg";
import { TABLES } from "./copy-pglite-to-postgres.js";

const url = process.env.SCAFFOLD_DATABASE_URL;
if (!url) {
  console.error("SCAFFOLD_DATABASE_URL not set");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const present = await pool.query(
    `SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public', 'drizzle') ORDER BY schemaname, tablename`,
  );
  const fq = present.rows.map(
    (r: { schemaname: string; tablename: string }) =>
      `${r.schemaname}.${r.tablename}`,
  );
  console.log("tables:", fq.join(", "));

  const expected = [
    ...TABLES.map((t) => `public.${t.name}`),
    "drizzle.__drizzle_migrations",
  ];
  const missing = expected.filter((n) => !fq.includes(n));
  if (missing.length > 0) {
    console.error("MISSING:", missing.join(", "));
    process.exit(1);
  }
  console.log(
    `OK: all ${TABLES.length} application tables + drizzle.__drizzle_migrations present`,
  );

  const checkConstraint = await pool.query(
    `SELECT conname FROM pg_constraint WHERE conname = 'tasks_agent_type_override_check'`,
  );
  if (checkConstraint.rows.length !== 1) {
    console.error("MISSING CHECK constraint: tasks_agent_type_override_check");
    process.exit(1);
  }
  console.log("OK: tasks_agent_type_override_check constraint present");

  for (const t of TABLES) {
    const r = await pool.query(`SELECT count(*)::int AS c FROM "${t.name}"`);
    const c = (r.rows[0] as { c: number }).c;
    if (c !== 0) {
      console.error(`NON-EMPTY: ${t.name} = ${c}`);
      process.exit(1);
    }
  }
  console.log("OK: every application table is empty");
} finally {
  await pool.end();
}
