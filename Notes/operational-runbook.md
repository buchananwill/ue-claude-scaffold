# Operational Runbook

Operator-facing recipes for the coordination server. Aimed at humans, not agents.

## Database backend

The coordination server connects to Postgres on Supabase via `SCAFFOLD_DATABASE_URL`. When the env var is unset, the
server falls back to a local PGlite instance at [server/data/pglite](../server/data/pglite). The fallback path is
intended for tests and offline development.

The scaffold deliberately ignores a user-level `DATABASE_URL`. The resolver
in [server/src/db-env.ts](../server/src/db-env.ts) reads `SCAFFOLD_DATABASE_URL` and overwrites
`process.env.DATABASE_URL` for this process only — co-installed Supabase projects on the same machine cannot hijack the
connection.

## Roll back from Supabase to PGlite

Use this when Supabase is unavailable or you need to revert to the pre-cutover snapshot. **Destructive: any data written
to Supabase since cutover is lost.** Only do this in an emergency.

1. Stop the coordination server (`./stop.sh --drain`, then Ctrl-C the dev server).
2. In the shell that runs the server: `unset SCAFFOLD_DATABASE_URL` (or remove it from your shell rc / `.env` consumer).
3. Restore the PGlite snapshot to [server/data/pglite](../server/data/pglite). The cutover left a snapshot at
   `server/data/pglite-pre-cutover-<timestamp>` — `mv` it back to `server/data/pglite`.
4. Restart the server. The startup banner should read `DB: pglite (./data/pglite)`.

After rollback, Supabase still holds the (now-orphaned) post-cutover writes. Decide whether to keep them as forensic
data or drop the Supabase tables.

## Restore from an in-database `public` backup schema

Use this when a schema-level cutover (e.g. the durable-task FSM rework) has been applied to Supabase, has gone wrong, and
you took a snapshot of the original `public` schema beforehand into `public_backup_<timestamp>_<purpose>` (same DB,
different schema). Atomic — either the entire restore succeeds or `public` stays untouched.

**Currently available snapshot:** `public_backup_20260511_pre_fsm` on project `yyatxrfacdvjmhhzfive`
(ue-claude-scaffold-2). Captured 2026-05-11 before the durable-task FSM cutover. Delete the schema once the FSM rework
is integrated and you're confident the cutover holds.

1. Stop the coordination server and every container (`./stop.sh`). No new writes may touch `public` during the rename.
2. Confirm the backup schema's row counts still match what you expect (cross-check against the cutover-time snapshot
   in any debrief or chat log).
3. Run the restore in one transaction against the target Supabase project:
   ```sql
   BEGIN;
   DROP SCHEMA public CASCADE;
   ALTER SCHEMA public_backup_20260511_pre_fsm RENAME TO public;
   COMMIT;
   ```
   You can issue this through the Supabase MCP `execute_sql` tool, the dashboard SQL editor, or `psql` over the
   Supavisor session-mode pooler. Each is equivalent.
4. Restart the coordination server. The startup banner should read `DB: supabase (…)` and the schema-verify script
   in [server/scripts/verify-supabase-schema.ts](../server/scripts/verify-supabase-schema.ts) should pass against the
   pre-cutover table list.
5. Re-launch a single container with `./launch.sh --dry-run` to confirm config resolution still works against the
   restored schema before re-engaging the task queue.

**Caveat:** the backup schema covers application tables in `public` only. The `auth.*` schema and extension schemas
(`extensions`, `cron`, etc.) are not touched by this procedure — they are not touched by the cutover migration either,
so no action is needed, but be aware that a restore here does not reset them.

## Take a fresh in-database `public` backup before the next cutover

Use this before any cutover-class migration (table rename + recreate, schema fork, destructive ALTER) on a Supabase
project where you do not have a tested external backup. Co-locates the snapshot in the same DB so the restore path is
pure SQL.

1. Stop the coordination server and every container first. Otherwise the snapshot is torn across tables.
2. Confirm storage headroom: the snapshot roughly doubles `public`'s footprint. On Free tier (500 MB cap), check
   `SELECT pg_size_pretty(pg_database_size(current_database()))` first.
3. Pick a schema name of the form `public_backup_<YYYYMMDD>_<purpose>` so it's self-documenting and sortable.
4. Run, against the target project (via Supabase MCP `execute_sql` or psql):
   ```sql
   CREATE SCHEMA public_backup_<YYYYMMDD>_<purpose>;
   ```
   Then, for each table in `public`:
   ```sql
   CREATE TABLE public_backup_<YYYYMMDD>_<purpose>.<tbl> (LIKE public.<tbl> INCLUDING ALL);
   INSERT INTO public_backup_<YYYYMMDD>_<purpose>.<tbl> SELECT * FROM public.<tbl>;
   ```
   `LIKE INCLUDING ALL` carries columns, defaults, NOT NULL, CHECK constraints, and indexes — but not FKs and not
   `serial`-owned sequences. Both need a follow-up pass.
5. Re-create each `serial` column's sequence in the backup schema, align its `last_value` to the source `MAX(id)`,
   rebind the backup table's column default to the new sequence, and `OWNED BY` the column so it drops cleanly. A
   ready-made plpgsql block that walks the backup schema's nextval defaults is in the conversation that produced
   `public_backup_20260511_pre_fsm` — adapt the schema name.
6. Replay foreign keys: query `pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace`, rewrite each
   `pg_get_constraintdef` to reference the backup schema, execute each `ALTER TABLE backup.<tbl> ADD CONSTRAINT ...`.
7. Verify: per-table row counts match source, FK count matches source, sequence count matches source, and every
   backup-table nextval default is qualified with the backup schema name (not unqualified — unqualified names resolve
   via `search_path` and break after `DROP SCHEMA public CASCADE`).

## Verify the Supabase target

The diagnostic scripts in [server/scripts/](../server/scripts/) require `SCAFFOLD_DATABASE_URL` exported.

- [verify-supabase-schema.ts](../server/scripts/verify-supabase-schema.ts) — confirm all 15 application tables and
  `drizzle.__drizzle_migrations` exist; abort if any non-empty.
- [compare-row-counts.ts](../server/scripts/compare-row-counts.ts) — per-table row-count parity between a PGlite
  directory and Supabase. Useful sanity check after a manual data restore or migration.

## Re-run a copy from a PGlite snapshot

[server/scripts/copy-pglite-to-postgres.ts](../server/scripts/copy-pglite-to-postgres.ts) refuses to run if the target
is non-empty. To re-copy, drop and re-create the target schema first (
`SCAFFOLD_DATABASE_URL=... npm run --prefix server db:migrate` after manually truncating the public-schema tables on
Supabase), then run the copy script. Always run with `--dry-run` first to confirm source row counts.
