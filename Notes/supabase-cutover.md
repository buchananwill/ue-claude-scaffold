# Supabase Cutover

## Goal
Move the scaffold coordination server's backing database from local PGlite to a Supabase Postgres instance, preserving every row, and kill the inherited-`DATABASE_URL` hijack hazard along the way.

## Context
- The drizzle factory at [server/src/drizzle-instance.ts](../server/src/drizzle-instance.ts) already handles both backends: when `process.env.DATABASE_URL` is set it builds a `node-postgres` pool and runs migrations via `drizzle-orm/node-postgres/migrator.migrate`; otherwise it spins up `@electric-sql/pglite.PGlite` against the on-disk dir at `./data/pglite` and runs `drizzle-orm/pglite/migrator.migrate`. **No parallel `db-supabase.ts` module is needed** — the old 2026-03-27 migration audit predates Drizzle and is obsolete.
- One Drizzle migration set ([server/drizzle/](../server/drizzle/) `0000`–`0005`) targets both backends; the same SQL applies cleanly on Supabase.
- The current PGlite pin lives at [server/src/index.ts:40](../server/src/index.ts) — `delete process.env.DATABASE_URL;`. It exists because the user's shell inherits a `DATABASE_URL` from an unrelated Supabase project on the same machine ([memory: project_database_url_hijack_hazard.md](../../../../.claude/projects/D--coding-ue-claude-scaffold/memory/project_database_url_hijack_hazard.md)).
- The cutover is offline: server is drained first, copy runs against a static PGlite, server restarts pointed at Supabase. No live-replication or delta-reconciliation.
- Schema is unchanged. The 15 tables in [server/src/schema/tables.ts](../server/src/schema/tables.ts) ship as-is.
- Out of scope: a `dotenv` loader for `server/.env` (today the file is documentation only). The new env var is set by whatever shell launches the server.
- Out of scope: the dashboard. It talks to the server over HTTP and is unaffected.

### FK dependency order (canonical)
Parents must be inserted before children. Used by Phases 3 and 5; do not re-derive elsewhere.

```
1. projects
2. agents
3. rooms
4. teams
5. room_members         (→ rooms, agents)
6. team_members         (→ teams, agents)
7. chat_messages        (→ rooms, agents; self-FK on reply_to)
8. tasks                (→ projects, agents)
9. task_files           (→ tasks)
10. task_dependencies   (→ tasks)
11. messages            (→ projects, agents)
12. build_history       (→ projects, agents)
13. files               (→ projects, agents)
14. ubt_lock            (→ agents)
15. ubt_queue           (→ agents)
```

### Worked example: insert order
If `tasks` is copied before `agents`, every row with a non-null `claimed_by_agent_id` raises `foreign key violation on agents`. Inserting in the order above guarantees every FK target exists at the time the child row is inserted. The list above is the source of truth — the copy script and the smoke checks both consume it from this section.

<!-- PHASE-BOUNDARY -->

## Phase 1 — Introduce `SCAFFOLD_DATABASE_URL` knob

**Outcome:** A user-level inherited `DATABASE_URL` no longer affects the scaffold server. When `SCAFFOLD_DATABASE_URL` is set, the server connects to that Postgres; when it is unset, the server falls back to PGlite. The current `delete process.env.DATABASE_URL` pin is gone, and `npm run db:migrate` honors the same precedence.

**Types / APIs:**

New helper module [server/src/db-env.ts](../server/src/db-env.ts):

```ts
/**
 * Resolve the scaffold's own database URL, immune to inherited DATABASE_URL.
 *
 * Reads SCAFFOLD_DATABASE_URL. If set, copies it onto process.env.DATABASE_URL
 * (so the existing drizzle-instance factory branch fires). If unset, deletes
 * any inherited DATABASE_URL so the factory falls back to PGlite.
 *
 * Must be called once, before initDrizzle(), at process start.
 */
export function applyScaffoldDatabaseUrl(): { backendHint: 'postgres' | 'pglite' };
```

**Work:**
- Create `server/src/db-env.ts` exporting `applyScaffoldDatabaseUrl` per the signature above. Implementation: read `process.env.SCAFFOLD_DATABASE_URL`; if non-empty, set `process.env.DATABASE_URL` to that value and return `{ backendHint: 'postgres' }`; otherwise `delete process.env.DATABASE_URL` and return `{ backendHint: 'pglite' }`.
- In [server/src/index.ts](../server/src/index.ts), replace the `delete process.env.DATABASE_URL;` line (currently line 40) with `import { applyScaffoldDatabaseUrl } from './db-env.js';` at the import block and a call `applyScaffoldDatabaseUrl();` immediately before `loadConfig()`.
- In [server/src/migrate.ts](../server/src/migrate.ts), call `applyScaffoldDatabaseUrl()` before `initDrizzle(...)` so the standalone migration runner uses the same precedence.
- Update [.env.example](../.env.example): under the `── Database ──` section, replace the `# DATABASE_URL=...` example with `# SCAFFOLD_DATABASE_URL=postgresql://postgres:[password]@[host]:5432/postgres` and a one-line note that this scaffold deliberately ignores a user-level `DATABASE_URL` to avoid hijack from co-installed Supabase projects.
- Add unit tests in `server/src/db-env.test.ts`: (a) `SCAFFOLD_DATABASE_URL` set, `DATABASE_URL` set to a different value → after call, `DATABASE_URL` equals the scaffold value, `backendHint === 'postgres'`. (b) `SCAFFOLD_DATABASE_URL` unset, `DATABASE_URL` set → after call, `DATABASE_URL` is `undefined`, `backendHint === 'pglite'`. (c) Both unset → after call, `DATABASE_URL` is `undefined`, `backendHint === 'pglite'`.

**Verification:**
- `npm run typecheck` clean.
- `npx tsx --test src/db-env.test.ts` passes all three cases.
- Start dev server with no env vars set: `npm run dev` logs `DB: pglite (./data/pglite)` (existing behavior preserved).
- Start dev server with `SCAFFOLD_DATABASE_URL=<test url>` exported (use a throwaway local Postgres, not Supabase yet): logs `DB: postgres` and `/health` returns `db.backend: "postgres"`.
- With a stray `DATABASE_URL` exported but no `SCAFFOLD_DATABASE_URL`: logs `DB: pglite` (hijack neutralized).

<!-- PHASE-BOUNDARY -->

## Phase 2 — Provision Supabase project and apply migrations

**Outcome:** A fresh Supabase Postgres has the scaffold's full schema applied — all 15 tables empty, all CHECK constraints, indexes, and FK constraints in place. The `SCAFFOLD_DATABASE_URL` pointing at it is recorded somewhere the user can retrieve it on cutover day.

**Types / APIs:** None.

**Work:**
- Create a new Supabase project in the user's account. Region: pick one close to the user's machine.
- From the Supabase dashboard, capture the **Session pooler** connection string (port 5432) — *not* the Transaction pooler (port 6543), because Drizzle's migration runner opens long-lived transactions that the transaction pooler will sever. Format: `postgresql://postgres.<ref>:<password>@<region>.pooler.supabase.com:5432/postgres`.
- Store the URL where the user can copy it later (e.g. password manager, scratch file outside the repo). Do not commit it.
- From the repo's `server/` dir, run `SCAFFOLD_DATABASE_URL=<the url> npm run db:migrate`. Confirms migrations apply cleanly on a fresh Supabase.
- Open the Supabase SQL editor and run `select tablename from pg_tables where schemaname='public' order by tablename;`. Expect exactly the 15 tables listed in the canonical FK dependency order section, plus `__drizzle_migrations`.
- Spot-check one CHECK constraint: `select conname from pg_constraint where conname = 'tasks_agent_type_override_check';` — should return one row.

**Verification:**
- All 15 application tables present plus `__drizzle_migrations`.
- `select count(*) from agents;` returns 0 on every table.
- `npm run db:migrate` exits 0 on a second invocation (idempotent — Drizzle skips already-applied migrations).

<!-- PHASE-BOUNDARY -->

## Phase 3 — Author the copy script

**Outcome:** A standalone script `server/scripts/copy-pglite-to-postgres.ts` that reads from a PGlite directory and writes every row to a Postgres URL, in FK-dependency order, with sequence resets afterward, and exits non-zero on any error.

**Types / APIs:**

```ts
/**
 * Copy every row from a PGlite snapshot to a Postgres database.
 * Both must already have the same Drizzle schema applied. Postgres must be empty
 * (the script aborts if any target table has rows).
 *
 * Usage:
 *   npx tsx scripts/copy-pglite-to-postgres.ts \
 *     --from ./data/pglite-snapshot \
 *     --to postgresql://...
 */
interface CopyOptions {
  fromPgliteDir: string;
  toPostgresUrl: string;
  /** If true, log per-table row counts but do not write. */
  dryRun?: boolean;
}

interface CopyResult {
  perTable: Array<{ table: string; rowsRead: number; rowsWritten: number }>;
  totalRowsRead: number;
  totalRowsWritten: number;
  durationMs: number;
}

async function copyPgliteToPostgres(opts: CopyOptions): Promise<CopyResult>;
```

**Work:**
- Create `server/scripts/copy-pglite-to-postgres.ts`. It accepts `--from`, `--to`, and `--dry-run` flags.
- Open the source via `new PGlite(fromPgliteDir)` and the target via `new pg.Pool({ connectionString: toPostgresUrl })`.
- Pre-flight: query each of the 15 application tables on the target with `SELECT count(*)`; if any non-zero, abort with a clear error listing which tables are non-empty. (Prevents accidental duplicate-copy on re-runs.)
- For each table in the canonical FK dependency order section, run `SELECT *` on PGlite, then bulk-insert into Postgres using parameterized multi-row `INSERT INTO <table> (<cols>) VALUES (...), (...), ...`. Batch size: 500 rows. Use `pg`'s native parameter binding (`$1, $2, …`) — never string-interpolate values. `jsonb` columns pass through as JS objects; `pg` serializes them.
- After copying tables with `serial` PKs (`build_history`, `messages`, `tasks`, `chat_messages`, `ubt_queue`), run `SELECT setval(pg_get_serial_sequence('<table>', 'id'), COALESCE((SELECT MAX(id) FROM <table>), 1), (SELECT COUNT(*) FROM <table>) > 0);` so the next inserted row gets a fresh PK. Skip tables with non-serial PKs (UUID/text/composite).
- Wrap the entire copy in a single Postgres transaction. On any error, the transaction rolls back and the target stays empty.
- Log per-table progress: `"agents: 12 rows copied"`. At the end, log totals.
- Exit 0 on success, non-zero on any failure.
- Dry-run mode (`--dry-run`): query row counts on PGlite per table, log them, exit 0 without writing.
- Add a basic unit test `server/scripts/copy-pglite-to-postgres.test.ts` that creates an in-memory PGlite with a few rows, copies to a second in-memory PGlite (treat both as Drizzle Postgres targets — `node-postgres` is overkill for the test), asserts row counts match. Acceptable to use two PGlite instances for the test since the wire protocol differs only at the connection layer; the SQL the script issues is portable.

**Verification:**
- `npm run typecheck` clean.
- Unit test passes.
- `npx tsx scripts/copy-pglite-to-postgres.ts --from ./data/pglite --to <empty-throwaway-postgres> --dry-run` lists row counts for all 15 tables.

<!-- PHASE-BOUNDARY -->

## Phase 4 — Dry-run the copy against a scratch Supabase target

**Outcome:** A full copy from the live `./data/pglite` (snapshot taken while the server is still up) lands cleanly into a *throwaway* Supabase database, and a row-count comparison shows source and destination identical for every table.

**Types / APIs:** None.

**Work:**
- The server stays running during this phase. It is read-only access to PGlite — safe.
- Take a snapshot of the PGlite data dir: `cp -r server/data/pglite server/data/pglite-snapshot-dryrun` (Windows: `xcopy /E /I server\data\pglite server\data\pglite-snapshot-dryrun`). The snapshot is a static copy that will not change while the dry-run runs; the live PGlite continues serving the running server.
- Provision a *second* Supabase project (or a separate schema in the existing one) for dry-run. Apply migrations with `SCAFFOLD_DATABASE_URL=<dry-run-url> npm run db:migrate`.
- Run `npx tsx scripts/copy-pglite-to-postgres.ts --from ./data/pglite-snapshot-dryrun --to <dry-run-url>`.
- Compare row counts table-by-table. Build a small ad-hoc check: for each of the 15 tables, query `SELECT count(*) FROM <t>` on both the snapshot (via `npx tsx -e` opening PGlite) and the dry-run Supabase. They must match exactly.
- Spot-check one row from a complex table: pick one `tasks` row by id from the snapshot, fetch the same id from Supabase, assert all columns equal (including `acceptance_criteria`, `result` jsonb, `agent_type_override`).
- Tear down the dry-run Supabase project (or drop its tables) once verified. Delete `server/data/pglite-snapshot-dryrun`.

**Verification:**
- All 15 row-count comparisons match.
- The spot-checked `tasks` row matches across all columns.
- The script exits 0.
- The running server is unaffected: `/health` still returns `db.backend: "pglite"` throughout.

<!-- PHASE-BOUNDARY -->

## Phase 5 — Cutover during a quiet window

**Outcome:** The production server is restarted against the real Supabase database with the full PGlite contents migrated. `/health` reports `db.backend: "postgres"`. `/status` shows agents, tasks, and recent messages identical to pre-cutover. PGlite data dir is preserved as a rollback artifact.

**Types / APIs:** None.

**Work:**
- Confirm with the user that the workload is quiet and they want to proceed. The cutover runs sequentially from here.
- `./stop.sh --drain` from the repo root. Wait for it to confirm all containers stopped and pumps paused.
- Stop the coordination server itself (Ctrl-C in the terminal running `npm run dev`, or `./stop.sh` if it manages it).
- Take the final PGlite snapshot: `cp -r server/data/pglite server/data/pglite-final-snapshot-<timestamp>`.
- Run the copy script against the **real** Supabase URL (the one captured in Phase 2): `npx tsx scripts/copy-pglite-to-postgres.ts --from ./data/pglite-final-snapshot-<timestamp> --to <production-url>`. Copy must complete with exit 0.
- Row-count parity check: same comparison as Phase 4, this time against the production Supabase. All 15 tables match.
- Export `SCAFFOLD_DATABASE_URL=<production-url>` in the shell that will run the server. Start the server: `npm run dev` (or however the user normally runs it).
- Smoke checks:
  - `curl http://localhost:9100/health` → `db.backend: "postgres"`, pool fields populated.
  - `curl http://localhost:9100/status` → returns the same set of agent names, task counts, and recent message ids that were visible pre-cutover (compare against a snapshot of `/status` taken before stopping the server).
  - `curl http://localhost:9100/projects` → returns the seeded projects.
- Move the live PGlite dir aside: rename `server/data/pglite` to `server/data/pglite-pre-cutover-<timestamp>`. The directory is the rollback artifact and must not be deleted in this phase.

**Verification:**
- `/health` reports `db.backend: "postgres"`.
- All smoke endpoints respond and the data shape matches the pre-cutover snapshot.
- Server logs show no FK errors, no migration errors, no pool connection errors during a 5-minute idle window.
- A test container launch via `./launch.sh --dry-run` resolves config without errors. (Real launch optional — depends on whether the user wants to immediately resume work.)

<!-- PHASE-BOUNDARY -->

## Phase 6 — Document rollback and update CLAUDE.md

**Outcome:** Future-you (or another operator) can read the current state of the repo and know (a) the scaffold runs on Supabase, (b) what `SCAFFOLD_DATABASE_URL` is, (c) how to roll back to PGlite if Supabase becomes unavailable.

**Types / APIs:** None.

**Work:**
- Update [CLAUDE.md](../CLAUDE.md) §Architecture — replace the line describing PGlite as the backing store with: "Coordination server stores state in a Supabase Postgres reached via `SCAFFOLD_DATABASE_URL`. PGlite remains supported as a fallback when `SCAFFOLD_DATABASE_URL` is unset (e.g. for tests and offline development)."
- Update [CLAUDE.md](../CLAUDE.md) §Configuration Split — note `SCAFFOLD_DATABASE_URL` as the canonical knob and explain the reason for the indirection (avoid hijack from a co-installed unrelated `DATABASE_URL`).
- Add a short rollback recipe to CLAUDE.md or a sibling `notes/operational-runbook.md` (operator's call): "To roll back to PGlite: stop the server, `unset SCAFFOLD_DATABASE_URL`, rename `server/data/pglite-pre-cutover-<timestamp>` back to `server/data/pglite`, restart. Data written to Supabase since cutover is lost — accept this is a destructive rollback for emergencies only."
- Once the operator is confident in Supabase (suggested: 1 week of uneventful operation), the `pglite-pre-cutover-<timestamp>` directory and `coordination.db*` legacy SQLite files at the server/ root can be deleted in a separate cleanup commit. Not in scope for this plan.

**Verification:**
- CLAUDE.md no longer claims PGlite as the production backing store.
- `SCAFFOLD_DATABASE_URL` appears in CLAUDE.md and `.env.example`.
- Rollback recipe is written down somewhere in the repo.
