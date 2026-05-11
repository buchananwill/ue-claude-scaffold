import { PGlite } from "@electric-sql/pglite";

const dir = process.argv[2] ?? "./data/pglite-fsm-test";
const tables = ["tasks", "task_files", "task_dependencies", "claude_code_container_sessions"];

const pglite = new PGlite(dir);

for (const t of tables) {
  console.log(`\n=== ${t} ===`);

  const constraints = await pglite.query<{ conname: string; contype: string }>(
    `SELECT c.conname, c.contype
     FROM pg_constraint c
     JOIN pg_class cl     ON cl.oid = c.conrelid
     JOIN pg_namespace n  ON n.oid  = cl.relnamespace
     WHERE n.nspname = 'public' AND cl.relname = $1
     ORDER BY c.contype, c.conname`,
    [t]
  );
  console.log("Constraints:");
  for (const r of constraints.rows) {
    const kind = { p: "PK", f: "FK", u: "UNIQUE", c: "CHECK" }[r.contype as "p"|"f"|"u"|"c"] ?? r.contype;
    console.log(`  [${kind}] ${r.conname}`);
  }

  const indexes = await pglite.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`,
    [t]
  );
  console.log("Indexes:");
  for (const r of indexes.rows) console.log(`  ${r.indexname}`);
}

await pglite.close();
