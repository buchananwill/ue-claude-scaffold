# Debrief 0120 -- Migration Review Cycle 4 Fixes

## Task Summary
Fix three review findings from cycle 3 on migration SQL files 0003 and 0004.

## Changes Made
- **server/drizzle/0003_backfill_and_orphans.sql**: Changed STEP 11 orphan agents cleanup from soft-delete (UPDATE status='deleted') to hard DELETE, because 0004 adds agents_project_fk which validates ALL existing rows and soft-deleted rows with invalid project_id would block FK creation.
- **server/drizzle/0004_constraints_and_swap.sql**: Lowercased all 9 instances of `ON DELETE RESTRICT` to `ON DELETE restrict` to match baseline convention.
- **server/drizzle/0004_constraints_and_swap.sql**: Added operational comment at top warning that server must be stopped before applying this migration.

## Design Decisions
All three changes are direct applications of the review findings with no discretion needed.

## Build & Test Results
Pending initial build.

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
