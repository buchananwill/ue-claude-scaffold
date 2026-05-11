import { PGlite } from "@electric-sql/pglite";

const dir = process.argv[2] ?? "./server/data/pglite";
const pglite = new PGlite(dir);

console.log(`=== PGlite at ${dir} ===\n`);

const tables = await pglite.query<{ tablename: string }>(
  `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
);
console.log("Tables in public schema:");
for (const r of tables.rows) console.log("  " + r.tablename);

console.log("\nRow counts per table:");
for (const r of tables.rows) {
  try {
    const c = await pglite.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM "${r.tablename}"`
    );
    console.log(`  ${r.tablename.padEnd(40)} ${String(c.rows[0].c).padStart(8)}`);
  } catch (e) {
    console.log(`  ${r.tablename.padEnd(40)}  ERROR ${(e as Error).message}`);
  }
}

console.log("\nMigration journal (drizzle.__drizzle_migrations):");
try {
  const m = await pglite.query<{ id: number; hash: string; created_at: string }>(
    `SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`
  );
  for (const r of m.rows) console.log(`  ${r.id}\t${r.hash}\t${r.created_at}`);
} catch (e) {
  console.log("  no migration journal found: " + (e as Error).message);
}

console.log("\nForeign key constraints:");
const fks = await pglite.query<{
  table_name: string;
  constraint_name: string;
  fk_def: string;
}>(
  `SELECT cl.relname AS table_name, c.conname AS constraint_name, pg_get_constraintdef(c.oid) AS fk_def
   FROM pg_constraint c
   JOIN pg_class cl     ON cl.oid = c.conrelid
   JOIN pg_namespace n  ON n.oid  = cl.relnamespace
   WHERE c.contype = 'f' AND n.nspname = 'public'
   ORDER BY cl.relname, c.conname`
);
console.log("  " + String(fks.rows.length).padStart(3) + " FKs total");
for (const r of fks.rows) console.log(`    ${r.table_name}.${r.constraint_name} :: ${r.fk_def}`);

await pglite.close();
