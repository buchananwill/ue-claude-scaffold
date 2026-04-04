# Add foreign key constraints on project_id

## Context

All 9 data tables have a `project_id` text column but no FK constraint referencing the `projects` table. Invalid project IDs can be silently inserted (demonstrated when a migration script wrote `ue-claude-scaffold` instead of the correct `scaffold`). This is a basic data integrity gap that should have been in the original schema.

## Phase 1: Schema changes

Add `.references(() => projects.id)` and remove `.default('default')` on all 9 tables in `server/src/schema/tables.ts`:

| Table | Line | Current | Change |
|-------|------|---------|--------|
| `agents` | 20 | `text('project_id').notNull().default('default')` | add `.references()`, drop `.default()` |
| `ubtLock` | 32 | `text('project_id').primaryKey().default('default')` | add `.references()`, drop `.default()` |
| `ubtQueue` | 41 | `text('project_id').notNull().default('default')` | add `.references()`, drop `.default()` |
| `buildHistory` | 50 | `text('project_id').notNull().default('default')` | add `.references()`, drop `.default()` |
| `messages` | 65 | `text('project_id').notNull().default('default')` | add `.references()`, drop `.default()` |
| `tasks` | 84 | `text('project_id').notNull().default('default')` | add `.references()`, drop `.default()` |
| `files` | 106 | `text('project_id').notNull().default('default')` | add `.references()`, drop `.default()` |
| `rooms` | 137 | `text('project_id').notNull().default('default')` | add `.references()`, drop `.default()` |
| `teams` | 170 | `text('project_id').notNull().default('default')` | add `.references()`, drop `.default()` |

No `onDelete: 'cascade'` - deleting a project with child data should fail. The existing `hasReferencingData()` guard in `projects.ts:120` provides a friendly error; the FK provides a DB-level guarantee.

## Phase 2: Generate and hand-edit the migration

1. Run `npx drizzle-kit generate` to produce `server/drizzle/0002_*.sql`
2. Hand-edit the generated SQL to prepend cleanup before FK constraints are added:

```sql
-- Clean up orphaned 'default' project_id rows (no project row exists for 'default')
DELETE FROM team_members WHERE team_id IN (SELECT id FROM teams WHERE project_id = 'default');
DELETE FROM teams WHERE project_id = 'default';
DELETE FROM room_members WHERE room_id IN (SELECT id FROM rooms WHERE project_id = 'default');
DELETE FROM chat_messages WHERE room_id IN (SELECT id FROM rooms WHERE project_id = 'default');
DELETE FROM rooms WHERE project_id = 'default';
DELETE FROM task_files WHERE task_id IN (SELECT id FROM tasks WHERE project_id = 'default');
DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE project_id = 'default')
  OR depends_on IN (SELECT id FROM tasks WHERE project_id = 'default');
DELETE FROM tasks WHERE project_id = 'default';
DELETE FROM messages WHERE project_id = 'default';
DELETE FROM files WHERE project_id = 'default';
DELETE FROM build_history WHERE project_id = 'default';
DELETE FROM ubt_queue WHERE project_id = 'default';
DELETE FROM ubt_lock WHERE project_id = 'default';
DELETE FROM agents WHERE project_id = 'default';

-- Then the generated ALTER TABLE ... DROP DEFAULT and ADD CONSTRAINT statements follow
```

## Phase 3: Remove application-level `'default'` fallbacks

These call sites silently fall back to `'default'` when no project is provided. With the FK, `'default'` is invalid (no such project row). Remove the fallbacks so missing project IDs surface as errors:

| File | Location | Current | Change |
|------|----------|---------|--------|
| `server/src/queries/agents.ts` | line 23 | `projectId = 'default'` | remove default from destructuring |
| `server/src/queries/agents.ts` | line 116 | returns `'default'` for unknown agent | return `null` or throw |
| `server/src/queries/messages.ts` | line 21 | `opts.projectId ?? 'default'` | require `projectId` in `InsertOpts` |
| `server/src/queries/rooms.ts` | line 21 | `opts.projectId ?? 'default'` | require `projectId` in `CreateRoomOpts` |
| `server/src/queries/teams.ts` | line 19 | `opts.projectId ?? 'default'` | require `projectId` in `CreateOpts` |
| `server/src/queries/teams.ts` | line 48 | `opts.projectId ?? 'default'` | require `projectId` in `CreateWithRoomOpts` |
| `server/src/routes/agents.ts` | line 35 | `row.projectId ?? 'default'` | just use `row.projectId` |

## Phase 4: Update test DDL

Tests use a hand-written `SCHEMA_DDL` in `server/src/queries/test-utils.ts`, not Drizzle migrations. Update the DDL to:

1. Add FK constraints on `project_id` columns matching the new schema (e.g. `REFERENCES "projects"("id")`)
2. Remove `DEFAULT 'default'` from all `project_id` columns
3. Append seed data: `INSERT INTO projects (id, name) VALUES ('default', 'Test Default');`

This seeds a `'default'` project for test use, so existing tests that rely on `projectId = 'default'` (via JS-level defaults in query function signatures) continue working without touching all 23 test files.

## Phase 5: Verify

1. `npx drizzle-kit generate` - produces clean migration
2. `npm run typecheck` in `server/` - no type errors
3. `npm test` in `server/` - all tests pass
4. Manual: start server, confirm seeded projects exist, attempt insert with bogus `project_id` and confirm FK violation
