---
title: "v7→v9 schema migration test fails: 'no such column: base_priority'"
priority: medium
reported-by: interactive-session
date: 2026-03-22
status: open
---

# v7→v9 schema migration test fails

## Problem

The test `openDb on a v7 database migrates CHECK constraint via writable_schema to v9` fails with:

```
openDb failed: no such column: base_priority SQLITE_ERROR
{ code: 'SQLITE_ERROR' }
```

The test creates a v7 database (before the `integrated`/`cycle` status and `base_priority` column were added) and then calls `openDb()` expecting the migration to bring it up to v9. The migration is failing because it references `base_priority` before the column exists — the ALTER TABLE that adds `base_priority` either isn't running or is running after a query that already depends on it.

## Likely cause

The migration steps are order-dependent: the `base_priority` column must be added before any prepared statements or queries that reference it. If `openDb()` prepares statements eagerly (e.g. the replan queries that SELECT `base_priority`), they'll fail on a v7 database that hasn't had the column added yet.

## Reproduction

```bash
npx tsx --test server/src/routes/tasks.test.ts
```

Look for the `v7 to v9 migration` suite. All other tests (141) pass.

## Notes

This test has been failing consistently across recent sessions. It does not affect production (new databases get the full schema), only upgrades from v7 databases.
