---
name: postgres-schema-indexing
description: PostgreSQL data types, index strategies, schema constraints, and diagnostic queries. Based on Supabase best practices.
axis: domain
origin: ECC-PSDE
---

# PostgreSQL Schema and Indexing

Data types, index strategies, and schema design for PostgreSQL.

## When to Activate

- Designing database schemas
- Choosing data types for columns
- Adding or reviewing indexes
- Troubleshooting slow queries

## Data Type Reference

| Use Case | Correct Type | Avoid |
|---|---|---|
| IDs | `bigint` (or UUIDv7) | `int`, random UUID as PK |
| Strings | `text` | `varchar(255)` without reason |
| Timestamps | `timestamptz` | `timestamp` (no timezone) |
| Money | `numeric(12,2)` | `float`, `real`, `double precision` |
| Flags | `boolean` | `varchar`, `int` |

## Index Cheat Sheet

| Query Pattern | Index Type | Example |
|---|---|---|
| `WHERE col = value` | B-tree (default) | `CREATE INDEX idx ON t (col)` |
| `WHERE col > value` | B-tree | `CREATE INDEX idx ON t (col)` |
| `WHERE a = x AND b > y` | Composite | `CREATE INDEX idx ON t (a, b)` |
| `WHERE jsonb @> '{}'` | GIN | `CREATE INDEX idx ON t USING gin (col)` |
| `WHERE tsv @@ query` | GIN (full-text) | `CREATE INDEX idx ON t USING gin (col)` |
| Time-series ranges | BRIN | `CREATE INDEX idx ON t USING brin (col)` |

## Index Patterns

**Composite index order** -- equality columns first, then range:

```sql
CREATE INDEX idx ON orders (status, created_at);
-- Works for: WHERE status = 'pending' AND created_at > '2024-01-01'
```

**Covering index** -- avoids table lookup:

```sql
CREATE INDEX idx ON users (email) INCLUDE (name, created_at);
```

**Partial index** -- smaller, faster:

```sql
CREATE INDEX idx ON users (email) WHERE deleted_at IS NULL;
```

## Schema Constraints

- Always define PK, FK with `ON DELETE` behavior, `NOT NULL` where appropriate, `CHECK` constraints
- Use `lowercase_snake_case` identifiers (no quoted mixed-case)
- Always index foreign keys -- no exceptions
- Index columns referenced in RLS policies

## Queue Processing Pattern

```sql
UPDATE jobs SET status = 'processing'
WHERE id = (
  SELECT id FROM jobs WHERE status = 'pending'
  ORDER BY created_at LIMIT 1
  FOR UPDATE SKIP LOCKED
) RETURNING *;
```

## Diagnostic Queries

```sql
-- Find unindexed foreign keys
SELECT conrelid::regclass, a.attname
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
WHERE c.contype = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid AND a.attnum = ANY(i.indkey)
  );

-- Find slow queries
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
WHERE mean_exec_time > 100
ORDER BY mean_exec_time DESC;
```

## Anti-Patterns

- `SELECT *` in production code
- Random UUIDs as primary keys (use UUIDv7 or IDENTITY)
- OFFSET pagination on large tables (use cursor pagination)
- Unparameterized queries (SQL injection risk)
- `GRANT ALL` to application users

*Based on Supabase best practices (MIT License)*
