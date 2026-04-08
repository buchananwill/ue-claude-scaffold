# Phase 4: Apply migration to local DB

Snapshot the local PGlite data directory, run the migration, verify the post-migration state. This phase is the point of no return for local data — the backup is the rollback.

Server code in subsequent phases (5–10) is written against the post-migration schema. Once Phase 4 succeeds, the pre-migration server cannot run against this DB.

## Files

- Local PGlite data directory (modify — migration applies)
- Local backup directory (new — snapshot)

## Work

1. Stop any running coordination server and containers. `./stop.sh` from the repo root. Verify `docker ps` shows no `claude-*` containers.
2. Snapshot the PGlite data directory: `cp -r <pglite-data-dir> <pglite-data-dir>.backup-pre-schema-hardening-$(date +%Y%m%d-%H%M%S)`. The data dir path is in `scaffold.config.json` or `.env` under `pgliteDataDir` (check `server/src/drizzle-instance.ts:39` for the field name). Do not skip this — it is the rollback path if the migration corrupts something the internal transaction rollback misses.
3. Run `cd server && npm run db:migrate`. Read the stdout carefully. Expect log lines from drizzle-orm's migrator indicating each of the three new files (`0002_add_columns.sql`, `0003_backfill_and_orphans.sql`, `0004_constraints_and_swap.sql`) is applied. Watch for any `UPDATE` or `DELETE` row counts the migrator surfaces — record them for Phase 14's post-migration verification.
4. If any migration file fails mid-run:
   - Read the specific SQL statement that raised the error.
   - If the failure is orphan-related (a backfill `UPDATE` missed a case, or a DELETE tried to remove a row that was unexpectedly referenced elsewhere), inspect the offending row and fix the policy in `0003_backfill_and_orphans.sql` or `0004_constraints_and_swap.sql`.
   - If the failure is PGlite-specific (a DDL form it does not support), substitute with the narrowest equivalent. Features verified on PGlite on 2026-04-08: `gen_random_uuid()`, `UPDATE ... FROM`, partial unique indexes, CHECK constraints with OR expressions. All four are supported.
   - Restore the backup directory, re-run the migration. Repeat until clean.
   - Do not silently weaken the schema. If a constraint cannot be enforced, stop and escalate to the operator.
5. After a successful run, open a psql-equivalent session (or query via the server's direct DB interface) and verify:
   - `SELECT COUNT(*) FROM agents WHERE id IS NULL` returns 0.
   - `SELECT COUNT(*) FROM agents` matches the pre-migration count (soft-deleted rows are still counted).
   - `information_schema.columns` shows `tasks.claimed_by` does NOT exist, `tasks.claimed_by_agent_id` exists.
   - `information_schema.columns` shows `room_members.member` does NOT exist, `room_members.agent_id` exists.
   - `information_schema.columns` shows `chat_messages.sender` does NOT exist, `chat_messages.author_type` and `chat_messages.author_agent_id` exist.
   - `information_schema.columns` shows `messages.agent` STILL exists (historical audit exception), alongside `messages.agent_id`.
   - `information_schema.table_constraints` shows `agents_pkey` is on `(id)`, `agents_project_name_unique` exists.
   - `information_schema.table_constraints` shows FK constraints on `tasks.claimed_by_agent_id`, `files.claimant_agent_id`, `build_history.agent_id`, `ubt_lock.holder_agent_id`, `ubt_queue.agent_id`, `messages.agent_id`, `team_members.agent_id`, `room_members.agent_id`, `chat_messages.author_agent_id`.
   - `information_schema.table_constraints` shows CHECK constraints `chat_messages_author_type_check` and `chat_messages_author_agent_check`.
   - `information_schema.table_constraints` shows `project_id` FKs on all 9 data tables.
6. Record the post-migration row counts per table in a scratch note (can be in the audit-scratch file). Compare to pre-migration counts; the delta on live-state tables should match the orphan cleanup logged by the migration, and historical tables should be unchanged.
7. Do not commit — no tracked files change in this phase. The commit boundary is at the end of Phase 3.

## Acceptance criteria

- `cd server && npm run db:migrate` exits 0 with all three migration files applied.
- A timestamped backup of the PGlite data directory exists alongside the live data directory.
- `agents.id` column is populated for every row (no NULLs).
- Old text columns on live-state tables are gone; new UUID FK columns are in place.
- `messages.agent` and `build_history.agent` columns still exist (historical audit exception).
- Every FK constraint named in Phase 3 step 4 exists in `information_schema.table_constraints`.
- Row count deltas per table match the migration's reported orphan cleanup; no unexplained losses.
- If the migration failed at any step, the backup directory is restored and the operator has a diagnostic log of the failure.
