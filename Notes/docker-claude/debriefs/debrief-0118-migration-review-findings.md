# Debrief 0118 -- Migration SQL Review Findings Fix

## Task Summary

Address all BLOCKING and WARNING findings from three independent reviewers on the migration SQL files (0002, 0003, 0004). Ten distinct issues were identified covering semicolons, identifier quoting, column name mismatches, wrong constraint names, missing soft-delete filters, missing project scoping, incorrect NOT NULL, missing safety guards, missing trailing breakpoint, and synthetic timestamps.

## Changes Made

- **server/drizzle/0002_add_columns.sql** -- Modified. Added semicolons to all SQL statements. Double-quoted all identifiers (table names, column names) to match baseline convention.
- **server/drizzle/0003_backfill_and_orphans.sql** -- Modified. (1) Added safety guard `UPDATE agents SET id = gen_random_uuid() WHERE id IS NULL` as first statement. (2) Added semicolons to all statements. (3) Double-quoted all identifiers. (4) Fixed `messages.agent` to `messages.from_agent` in STEP 9 UPDATE and comments. (5) Added `AND a.status != 'deleted'` filter to all backfill JOINs in STEPs 2-10. (6) Added project scoping (`ubt_queue.project_id = a.project_id`) to STEP 5 backfill. (7) Added trailing `--> statement-breakpoint` after STEP 11.
- **server/drizzle/0004_constraints_and_swap.sql** -- Modified. (1) Added semicolons to all statements. (2) Double-quoted all identifiers. (3) Fixed `team_members_pkey` to `team_members_team_id_agent_name_pk` (actual constraint name from 0000). (4) Fixed `room_members_pkey` to `room_members_room_id_member_pk` (actual constraint name from 0000). (5) Removed `ALTER TABLE build_history ALTER COLUMN agent_id SET NOT NULL` (contradicts nullable schema and orphan policy). (6) Fixed `messages.agent` KEEP comment to `messages.from_agent`. (7) Updated NOT NULL comment to explain build_history.agent_id is kept nullable.
- **server/drizzle/meta/_journal.json** -- Modified. Replaced synthetic +1000ms timestamps for entries 2-4 with realistic values based on current time (~40s and ~100s apart).

## Design Decisions

- Left `agents_pkey` and `ubt_lock_pkey` constraint names unchanged as instructed -- PostgreSQL auto-generates `<table>_pkey` for inline PRIMARY KEY declarations without explicit names.
- Used the alias `"cm"` for chat_messages in STEP 8 to match column-qualified references in the UPDATE SET clause.
- Kept the `--> statement-breakpoint` separator idiom consistent throughout.

## Build & Test Results

Pending build verification. SQL files are plain text and do not affect TypeScript compilation.

## Open Questions / Risks

- The Drizzle snapshot JSON files in `server/drizzle/meta/` for migrations 0002-0004 have not been created yet. These may be needed for `drizzle-kit` to function correctly at migration time.
- Pre-existing TS errors from Phase 2 schema changes are expected and unrelated to this work.

## Suggested Follow-ups

- Create snapshot JSON files for the three new migrations if drizzle-kit requires them.
- Run the full migration sequence against a test PGlite instance to validate correctness end-to-end.
