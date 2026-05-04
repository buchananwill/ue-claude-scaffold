/**
 * Throwaway: enumerate distinct JS types of values returned by PGlite for
 * jsonb-typed columns, to confirm whether scalars (strings/numbers/null) appear
 * in addition to objects/arrays.
 */
import { PGlite } from "@electric-sql/pglite";

const dir = process.argv[2] ?? "./server/data/pglite";
const client = new PGlite(dir);
try {
  const targets: Array<[string, string]> = [
    ["tasks", "result"],
    ["messages", "payload"],
    ["messages", "result"],
  ];
  for (const [table, col] of targets) {
    const r = await client.query(`SELECT "${col}" FROM "${table}"`);
    const counts: Record<string, number> = {};
    const samples: Record<string, unknown> = {};
    for (const row of r.rows as Array<Record<string, unknown>>) {
      const v = row[col];
      let kind: string;
      if (v === null) kind = "null";
      else if (Array.isArray(v)) kind = "array";
      else if (typeof v === "object") kind = "object";
      else kind = typeof v;
      counts[kind] = (counts[kind] ?? 0) + 1;
      if (!(kind in samples)) samples[kind] = v;
    }
    console.log(`${table}.${col}:`, counts);
    for (const [k, s] of Object.entries(samples)) {
      const repr = JSON.stringify(s);
      console.log(
        `  ${k} sample: ${repr.length > 120 ? repr.slice(0, 120) + "…" : repr}`,
      );
    }
  }
} finally {
  await client.close();
}
