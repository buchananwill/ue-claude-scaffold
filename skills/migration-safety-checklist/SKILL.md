---
name: migration-safety-checklist
description: Structural constraints and safety checklist for database migration files. Defines what a valid, safe migration looks like.
axis: schema
origin: ECC-PSDE
---

# Migration Safety Checklist

Constraints that define a valid, production-safe migration file.

## When to Activate

- Writing or reviewing a database migration
- Adding/removing columns, indexes, or constraints on existing tables

## Checklist

Before applying any migration:

- [ ] Migration has both UP and DOWN (or is explicitly marked irreversible)
- [ ] No full table locks on large tables (use concurrent operations)
- [ ] New columns are nullable or have a default (never add NOT NULL without default)
- [ ] Indexes on existing tables created with `CONCURRENTLY` (not inline)
- [ ] Data backfill is a separate migration from schema change
- [ ] Tested against a copy of production data
- [ ] Rollback plan documented

## Safe Column Addition

```sql
-- GOOD: Nullable column, no lock
ALTER TABLE users ADD COLUMN avatar_url TEXT;

-- GOOD: Column with default (Postgres 11+ is instant, no rewrite)
ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;

-- BAD: NOT NULL without default on existing table (full table rewrite + lock)
ALTER TABLE users ADD COLUMN role TEXT NOT NULL;
```

## Safe Index Creation

```sql
-- BAD: Blocks writes on large tables
CREATE INDEX idx_users_email ON users (email);

-- GOOD: Non-blocking, allows concurrent writes
CREATE INDEX CONCURRENTLY idx_users_email ON users (email);
-- Note: CONCURRENTLY cannot run inside a transaction block
```

## Safe Column Removal

```
Step 1: Remove all application references to the column
Step 2: Deploy application without the column reference
Step 3: Drop column in next migration
```

## Batched Data Migrations

```sql
-- BAD: Updates all rows in one transaction (locks table)
UPDATE users SET normalized_email = LOWER(email);

-- GOOD: Batch update
DO $$
DECLARE
  batch_size INT := 10000;
  rows_updated INT;
BEGIN
  LOOP
    UPDATE users
    SET normalized_email = LOWER(email)
    WHERE id IN (
      SELECT id FROM users
      WHERE normalized_email IS NULL
      LIMIT batch_size
      FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;
    COMMIT;
  END LOOP;
END $$;
```
