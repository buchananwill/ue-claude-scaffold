---
name: expand-contract-migration
description: Zero-downtime database migration protocol. Framework-agnostic process for safely evolving schemas in production.
axis: protocol
origin: ECC-PSDE
---

# Expand-Contract Migration Protocol

Zero-downtime schema evolution for production databases.

## When to Activate

- Renaming, removing, or restructuring columns/tables in a live system
- Any schema change where the old and new shapes must coexist during deployment

## The Three Phases

```
Phase 1: EXPAND
  - Add new column/table (nullable or with default)
  - Deploy: application writes to BOTH old and new
  - Backfill existing data in a separate migration

Phase 2: MIGRATE
  - Deploy: application reads from NEW, writes to BOTH
  - Verify data consistency between old and new

Phase 3: CONTRACT
  - Deploy: application only uses NEW
  - Drop old column/table in a separate migration
```

## Rules

1. **Every change is a migration file** -- never alter production databases manually
2. **Migrations are forward-only in production** -- rollbacks use new forward migrations
3. **Schema and data migrations are separate** -- never mix DDL and DML in one migration
4. **Migrations are immutable once deployed** -- never edit a migration that has run in production
5. **Test against production-sized data** -- a migration that works on 100 rows may lock on 10M

## Timeline Example

```
Day 1: Migration adds new_status column (nullable)
Day 1: Deploy app v2 -- writes to both status and new_status
Day 2: Run backfill migration for existing rows
Day 3: Deploy app v3 -- reads from new_status only
Day 7: Migration drops old status column
```

## Anti-Patterns

| Anti-Pattern | Why It Fails | Better Approach |
|---|---|---|
| Manual SQL in production | No audit trail, unrepeatable | Always use migration files |
| Editing deployed migrations | Causes drift between environments | Create new migration instead |
| Schema + data in one migration | Hard to rollback, long transactions | Separate migrations |
| Dropping column before removing code | Application errors on missing column | Remove code first, drop column next deploy |
