# Phase 15: Apply migration to local DB (operator, post-merge)

This phase is executed by the operator after all code phases (5–13) are complete and merged. It is NOT a mid-stream gate — container agents write code against the Drizzle schema declarations in `tables.ts` and validate via ephemeral PGlite instances in tests, without touching the host's live DB.

The host server continues running on the old (pre-migration) schema throughout container execution. Old column names still exist in the DB; the server's old code queries them normally. The migration is applied once, atomically, after the code is ready.

## Prerequisites

- All code phases (5–13) are merged onto the branch.
- `npm run typecheck` and `npm test` pass (Phase 13 gates).
- No containers are running.

## Files

- Local PGlite data directory (modify — migration applies)
- Local backup directory (new — snapshot)

## Work

1. Stop any running coordination server and containers. `./stop.sh` from the repo root. Verify `docker ps` shows no `claude-*` containers.
2. Snapshot the PGlite data directory: `cp -r <pglite-data-dir> <pglite-data-dir>.backup-pre-schema-hardening-$(date +%Y%m%d-%H%M%S)`. The data dir path is in `scaffold.config.json` or `.env` under `pgliteDataDir` (check `server/src/drizzle-instance.ts:39` for the field name). Do not skip this — it is the rollback path.
3. Run `cd server && npm run db:migrate`. Expect log lines from drizzle-orm's migrator indicating each of the three new files (`0002_add_columns.sql`, `0003_backfill_and_orphans.sql`, `0004_constraints_and_swap.sql`) is applied. Watch for any `UPDATE` or `DELETE` row counts the migrator surfaces — record them for Phase 16's post-migration verification.
4. If any migration file fails mid-run:
   - Read the specific SQL statement that raised the error.
   - If the failure is orphan-related, inspect the offending row and fix the policy in `0003_backfill_and_orphans.sql` or `0004_constraints_and_swap.sql`.
   - If the failure is PGlite-specific, substitute with the narrowest equivalent. Features verified on PGlite on 2026-04-08: `gen_random_uuid()`, `UPDATE ... FROM`, partial unique indexes, CHECK constraints with OR expressions. All four are supported.
   - Restore the backup directory, re-run the migration. Repeat until clean.
   - Do not silently weaken the schema. If a constraint cannot be enforced, stop and investigate.
5. After a successful run, verify:
   - `SELECT COUNT(*) FROM agents WHERE id IS NULL` returns 0.
   - `SELECT COUNT(*) FROM agents` matches the pre-migration count (soft-deleted rows are still counted).
   - `information_schema.columns` shows `tasks.claimed_by` does NOT exist, `tasks.claimed_by_agent_id` exists.
   - `information_schema.columns` shows `room_members.member` does NOT exist, `room_members.agent_id` exists.
   - `information_schema.columns` shows `chat_messages.sender` does NOT exist, `chat_messages.author_type` and `chat_messages.author_agent_id` exist.
   - `information_schema.columns` shows `messages.from_agent` STILL exists (historical audit exception), alongside `messages.agent_id`.
   - `information_schema.table_constraints` shows `agents_pkey` is on `(id)`, `agents_project_name_unique` exists.
   - `information_schema.table_constraints` shows FK constraints on `tasks.claimed_by_agent_id`, `files.claimant_agent_id`, `build_history.agent_id`, `ubt_lock.holder_agent_id`, `ubt_queue.agent_id`, `messages.agent_id`, `team_members.agent_id`, `room_members.agent_id`, `chat_messages.author_agent_id`.
   - `information_schema.table_constraints` shows CHECK constraints `chat_messages_author_type_check` and `chat_messages_author_agent_check`.
   - `information_schema.table_constraints` shows `project_id` FKs on the 7 project-scoped tables (`agents`, `tasks`, `files`, `messages`, `build_history`, `rooms`, `teams`). `ubt_lock` and `ubt_queue` have NO `project_id` FK.
   - `ubt_lock` PK is on `host_id`, not `project_id`. `ubt_lock` has no `project_id` column. `ubt_queue` has no `project_id` column.
6. Restart the server: `cd server && npm run dev`. Verify it starts cleanly with no migration errors.
7. Proceed to Phase 16 (operator smoke test).

## Acceptance criteria

- `cd server && npm run db:migrate` exits 0 with all three migration files applied.
- A timestamped backup of the PGlite data directory exists alongside the live data directory.
- `agents.id` column is populated for every row (no NULLs).
- Old text columns on live-state tables are gone; new UUID FK columns are in place.
- `messages.from_agent` and `build_history.agent` columns still exist (historical audit exception).
- Every FK constraint named above exists in `information_schema.table_constraints`.
- UBT tables have `host_id` PK and agent FKs, but no `project_id` column or FK.
- Row count deltas per table match the migration's reported orphan cleanup; no unexplained losses.
- Server restarts cleanly on the new code + new schema.
