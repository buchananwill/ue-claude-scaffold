/**
 * Copy every row from a PGlite snapshot to a Postgres database.
 *
 * Both must already have the same Drizzle schema applied. Postgres must be
 * empty — pre-flight aborts if any of the 15 application tables already
 * contain rows. The whole copy runs in a single transaction; on any error,
 * the transaction rolls back and the target is left empty.
 *
 * Usage:
 *   npx tsx scripts/copy-pglite-to-postgres.ts \
 *     --from ./data/pglite-snapshot \
 *     --to postgresql://...
 *
 *   npx tsx scripts/copy-pglite-to-postgres.ts \
 *     --from ./data/pglite-snapshot \
 *     --dry-run
 */
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

export interface TableSpec {
  /** SQL table name. */
  name: string;
  /** True if the table has a `serial` PK named `id` that needs setval() after copy. */
  hasSerialPk: boolean;
  /** ORDER BY clause for deterministic SELECT. Required for tables with intra-table self-FKs. */
  orderBy?: string;
  /**
   * Names of jsonb columns on this table. Values for these columns are
   * JSON.stringify'd before being sent as parameters, regardless of JS type —
   * scalar JSON values (strings, numbers, booleans) come back from PGlite as
   * native JS scalars, and pg would otherwise pass them as raw text that
   * Postgres rejects when parsing as jsonb.
   */
  jsonbColumns?: readonly string[];
}

/**
 * Canonical FK insertion order for the scaffold schema.
 * Source of truth: Notes/supabase-cutover.md "FK dependency order (canonical)".
 */
export const TABLES: readonly TableSpec[] = [
  { name: "projects", hasSerialPk: false, orderBy: "id" },
  { name: "agents", hasSerialPk: false, orderBy: "id" },
  { name: "rooms", hasSerialPk: false, orderBy: "id" },
  { name: "teams", hasSerialPk: false, orderBy: "id" },
  { name: "room_members", hasSerialPk: false, orderBy: "id" },
  { name: "team_members", hasSerialPk: false, orderBy: "team_id, agent_id" },
  { name: "chat_messages", hasSerialPk: true, orderBy: "id" },
  { name: "tasks", hasSerialPk: true, orderBy: "id", jsonbColumns: ["result"] },
  { name: "task_files", hasSerialPk: false, orderBy: "task_id, file_path" },
  {
    name: "task_dependencies",
    hasSerialPk: false,
    orderBy: "task_id, depends_on",
  },
  {
    name: "messages",
    hasSerialPk: true,
    orderBy: "id",
    jsonbColumns: ["payload", "result"],
  },
  { name: "build_history", hasSerialPk: true, orderBy: "id" },
  { name: "files", hasSerialPk: false, orderBy: "project_id, path" },
  { name: "ubt_lock", hasSerialPk: false, orderBy: "host_id" },
  { name: "ubt_queue", hasSerialPk: true, orderBy: "id" },
];

export type QueryRow = Record<string, unknown>;
export type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: QueryRow[] }>;

export interface SourceAdapter {
  query: QueryFn;
}

export interface TargetAdapter {
  /** Used for the pre-flight emptiness check, outside any transaction. */
  query: QueryFn;
  /** Run the inner copy inside a single transaction; throw to roll back. */
  withTransaction: <T>(fn: (txQuery: QueryFn) => Promise<T>) => Promise<T>;
}

export interface RunCopyOptions {
  source: SourceAdapter;
  target: TargetAdapter;
  tables: readonly TableSpec[];
  dryRun?: boolean;
  batchSize?: number;
  log?: (msg: string) => void;
}

export interface CopyResult {
  perTable: Array<{ table: string; rowsRead: number; rowsWritten: number }>;
  totalRowsRead: number;
  totalRowsWritten: number;
  durationMs: number;
}

/**
 * Adapt a JS value for use as a parameter in raw SQL.
 *
 * `forJsonb` should be true when the target column is `jsonb`. In that case
 * any non-null JS value is JSON.stringify'd so Postgres re-parses it as JSON
 * — handles objects, arrays, *and* scalar JSON values (strings, numbers,
 * booleans) which PGlite returns as native JS scalars and which would
 * otherwise be sent as raw text and rejected.
 *
 * For non-jsonb columns we still JSON.stringify objects and arrays defensively
 * (no scaffold table has Postgres array columns), but pass scalars through.
 */
function adaptValueForRawSql(v: unknown, forJsonb: boolean): unknown {
  if (v === null || v === undefined) return v;
  if (forJsonb) return JSON.stringify(v);
  if (typeof v !== "object") return v;
  if (v instanceof Date) return v;
  if (typeof Buffer !== "undefined" && v instanceof Buffer) return v;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

/**
 * Inner copy engine. Exported for testing — production callers use
 * copyPgliteToPostgres() which wires up real PGlite + pg.Pool adapters.
 */
export async function runCopy(opts: RunCopyOptions): Promise<CopyResult> {
  const { source, target, tables } = opts;
  const dryRun = opts.dryRun ?? false;
  const batchSize = opts.batchSize ?? 500;
  const log = opts.log ?? ((m) => console.log(m));
  const t0 = Date.now();

  if (!dryRun) {
    const nonEmpty: string[] = [];
    for (const t of tables) {
      const r = await target.query(
        `SELECT count(*)::int AS c FROM "${t.name}"`,
      );
      const c = (r.rows[0] as { c: number }).c;
      if (c > 0) nonEmpty.push(`${t.name} (${c} rows)`);
    }
    if (nonEmpty.length > 0) {
      throw new Error(
        `Target is not empty. Refusing to copy. Non-empty tables: ${nonEmpty.join(", ")}`,
      );
    }
  }

  if (dryRun) {
    const perTable: CopyResult["perTable"] = [];
    let totalRead = 0;
    for (const t of tables) {
      const r = await source.query(
        `SELECT count(*)::int AS c FROM "${t.name}"`,
      );
      const c = (r.rows[0] as { c: number }).c;
      log(`${t.name}: ${c} rows (dry-run)`);
      perTable.push({ table: t.name, rowsRead: c, rowsWritten: 0 });
      totalRead += c;
    }
    log(`dry-run total: ${totalRead} rows`);
    return {
      perTable,
      totalRowsRead: totalRead,
      totalRowsWritten: 0,
      durationMs: Date.now() - t0,
    };
  }

  const perTable: CopyResult["perTable"] = [];
  let totalRead = 0;
  let totalWritten = 0;

  await target.withTransaction(async (tx) => {
    for (const t of tables) {
      const orderBy = t.orderBy ? ` ORDER BY ${t.orderBy}` : "";
      const r = await source.query(`SELECT * FROM "${t.name}"${orderBy}`);
      const rows = r.rows;
      let written = 0;

      if (rows.length > 0) {
        const cols = Object.keys(rows[0]);
        const colList = cols.map((c) => `"${c}"`).join(", ");
        const jsonbSet = new Set(t.jsonbColumns ?? []);
        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize);
          const placeholders: string[] = [];
          const params: unknown[] = [];
          let p = 1;
          for (const row of batch) {
            const ph: string[] = [];
            for (const col of cols) {
              ph.push(`$${p++}`);
              params.push(adaptValueForRawSql(row[col], jsonbSet.has(col)));
            }
            placeholders.push(`(${ph.join(", ")})`);
          }
          await tx(
            `INSERT INTO "${t.name}" (${colList}) VALUES ${placeholders.join(", ")}`,
            params,
          );
          written += batch.length;
        }
      }

      log(`${t.name}: ${written} rows copied`);
      perTable.push({
        table: t.name,
        rowsRead: rows.length,
        rowsWritten: written,
      });
      totalRead += rows.length;
      totalWritten += written;
    }

    for (const t of tables) {
      if (!t.hasSerialPk) continue;
      await tx(
        `SELECT setval(
           pg_get_serial_sequence('"${t.name}"', 'id'),
           COALESCE((SELECT MAX(id) FROM "${t.name}"), 1),
           (SELECT COUNT(*) FROM "${t.name}") > 0
         )`,
      );
    }
  });

  const durationMs = Date.now() - t0;
  log(`total: read ${totalRead}, written ${totalWritten} in ${durationMs}ms`);
  return {
    perTable,
    totalRowsRead: totalRead,
    totalRowsWritten: totalWritten,
    durationMs,
  };
}

export interface CopyOptions {
  fromPgliteDir: string;
  toPostgresUrl: string;
  dryRun?: boolean;
}

/** Public API per Notes/supabase-cutover.md Phase 3. */
export async function copyPgliteToPostgres(
  opts: CopyOptions,
): Promise<CopyResult> {
  const pglite = new PGlite(opts.fromPgliteDir);
  await pglite.exec("SET timezone TO 'UTC'");

  const pool = new pg.Pool({
    connectionString: opts.toPostgresUrl,
    max: 4,
    connectionTimeoutMillis: 10_000,
  });

  const source: SourceAdapter = {
    query: async (sql, params) => {
      const r = await pglite.query(sql, params as unknown[]);
      return { rows: r.rows as QueryRow[] };
    },
  };

  const target: TargetAdapter = {
    query: async (sql, params) => {
      const r = await pool.query(sql, params as unknown[]);
      return { rows: r.rows as QueryRow[] };
    },
    withTransaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        try {
          const result = await fn(async (sql, params) => {
            const r = await client.query(sql, params as unknown[]);
            return { rows: r.rows as QueryRow[] };
          });
          await client.query("COMMIT");
          return result;
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        }
      } finally {
        client.release();
      }
    },
  };

  try {
    return await runCopy({
      source,
      target,
      tables: TABLES,
      dryRun: opts.dryRun,
    });
  } finally {
    await pglite.close();
    await pool.end();
  }
}

interface CliArgs {
  from: string;
  to: string;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { from: "", to: "", dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") args.from = argv[++i] ?? "";
    else if (a === "--to") args.to = argv[++i] ?? "";
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function printUsage(): void {
  console.log(
    [
      "Usage: copy-pglite-to-postgres.ts --from <pglite-dir> --to <postgres-url> [--dry-run]",
      "",
      "  --from <dir>   PGlite data directory to read from (required)",
      "  --to <url>     Postgres connection URL to write to (required unless --dry-run)",
      "  --dry-run      Read-only — log per-table source row counts and exit",
      "  --help, -h     Show this message",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.from) {
    printUsage();
    throw new Error("--from is required");
  }
  if (!args.to && !args.dryRun) {
    printUsage();
    throw new Error("--to is required (or pass --dry-run)");
  }

  const result = await copyPgliteToPostgres({
    fromPgliteDir: args.from,
    toPostgresUrl: args.to,
    dryRun: args.dryRun,
  });

  console.log(JSON.stringify(result, null, 2));
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url ===
    new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;

if (
  isMain ||
  (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
