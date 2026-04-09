# Debrief 0119 -- Migration Review Cycle 2 Fixes

## Task Summary

Fix all BLOCKING and WARNING findings from cycle 2 review of migration SQL files (0003 and 0004).

## Changes Made

- **server/drizzle/0003_backfill_and_orphans.sql**: Changed STEP 1 from soft-delete (UPDATE status='deleted') to hard-DELETE for duplicate agent rows. Soft-delete would violate the UNIQUE constraint added in 0004 since it covers all rows including soft-deleted ones.
- **server/drizzle/0004_constraints_and_swap.sql**: Schema-qualified all ~16 REFERENCES clauses with `"public".` prefix to match baseline convention from 0000.
- **server/drizzle/0004_constraints_and_swap.sql**: Added `ON UPDATE no action` to all 9 agent-reference FKs (after existing `ON DELETE RESTRICT`). Added `ON DELETE no action ON UPDATE no action` to all 7 project-id FKs.
- **server/drizzle/0004_constraints_and_swap.sql**: Renamed `team_members_pkey` to `team_members_team_id_agent_id_pk` and `room_members_pkey` to `room_members_id_pk` to match the project `<table>_<cols>_pk` convention.
- **server/drizzle/0004_constraints_and_swap.sql**: Added defensive cleanup UPDATE for chat_messages before the CHECK constraint, nullifying `author_agent_id` on operator/system rows that may have stale values from between-migration inserts.

## Design Decisions

- Drizzle schema (tables.ts) uses `primaryKey({ columns: [...] })` and `.primaryKey()` which generate constraint names automatically. The migration SQL names take precedence at runtime; no schema file changes were needed.
- The hard-DELETE in 0003 is safe because these duplicate rows are artifacts of the old PK bug and have no downstream FK references (the FK columns are added in 0004, after this cleanup).

## Build & Test Results

Pending initial build.

## Open Questions / Risks

None.

## Suggested Follow-ups

None.
