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
