# Phase 1 — DB schema and migration

Part of [Container Session Token Tracking](./_index.md). See the index for the shared goal and context — this phase body assumes them.

**Outcome:** The `claude_code_container_sessions` table exists in the Drizzle schema and a corresponding SQL migration file is present. Running `npm run db:migrate` from `server/` applies the migration without error on a clean PGlite instance.

**Types / APIs:**

New Drizzle table definition in `server/src/schema/tables.ts` (append as table 16):

```typescript
export const claudeCodeContainerSessions = pgTable('claude_code_container_sessions', {
  id:                   uuid('id').primaryKey(),
  projectId:            text('project_id').notNull().references(() => projects.id),
  agentId:              uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'restrict' }),
  taskId:               integer('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  status:               text('status').notNull().default('running'),
  startedAt:            timestamp('started_at').notNull().defaultNow(),
  endedAt:              timestamp('ended_at'),
  exitCode:             integer('exit_code'),
  inputTokens:          integer('input_tokens'),
  outputTokens:         integer('output_tokens'),
  cacheReadTokens:      integer('cache_read_tokens'),
  cacheCreationTokens:  integer('cache_creation_tokens'),
  rawOutput:            jsonb('raw_output'),
}, (table) => [
  check('ccs_status_check', sql`${table.status} IN ('running','complete','aborted','stopped')`),
  index('idx_ccs_project').on(table.projectId),
  index('idx_ccs_agent').on(table.agentId),
  index('idx_ccs_task').on(table.taskId),
  index('idx_ccs_project_started').on(table.projectId, table.startedAt.desc()),
]);
```

`timestamp` (without timezone) matches the convention used by every other table in the schema. Do not pass `{ withTimezone: true }`.

**Work:**
- Add the table definition above to `server/src/schema/tables.ts` after table 15 (`teamMembers`).
- Create `server/drizzle/0006_add_container_sessions.sql`:

```sql
CREATE TABLE "claude_code_container_sessions" (
  "id"                    uuid PRIMARY KEY,
  "project_id"            text NOT NULL REFERENCES "projects"("id"),
  "agent_id"              uuid NOT NULL REFERENCES "agents"("id"),
  "task_id"               integer REFERENCES "tasks"("id") ON DELETE SET NULL,
  "status"                text NOT NULL DEFAULT 'running',
  "started_at"            timestamp NOT NULL DEFAULT now(),
  "ended_at"              timestamp,
  "exit_code"             integer,
  "input_tokens"          integer,
  "output_tokens"         integer,
  "cache_read_tokens"     integer,
  "cache_creation_tokens" integer,
  "raw_output"            jsonb,
  CONSTRAINT "ccs_status_check" CHECK ("status" IN ('running','complete','aborted','stopped'))
);
--> statement-breakpoint
CREATE INDEX "idx_ccs_project" ON "claude_code_container_sessions" ("project_id");
--> statement-breakpoint
CREATE INDEX "idx_ccs_agent" ON "claude_code_container_sessions" ("agent_id");
--> statement-breakpoint
CREATE INDEX "idx_ccs_task" ON "claude_code_container_sessions" ("task_id");
--> statement-breakpoint
CREATE INDEX "idx_ccs_project_started" ON "claude_code_container_sessions" ("project_id", "started_at" DESC);
```

`timestamp` (without time zone) is mandatory here — it matches every other timestamp column in the schema. Do not change to `timestamptz`.

**Verification:** `cd server && npm run db:migrate` completes without error (targets PGlite in-container; validates the SQL is correct). Run `npm test` — no existing tests should fail. **Operator post-merge step:** run `npm run db:migrate` with `SCAFFOLD_DATABASE_URL` set to apply the migration to Supabase.
