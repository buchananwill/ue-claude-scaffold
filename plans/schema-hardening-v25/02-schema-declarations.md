# Phase 2: Schema declarations in tables.ts

All Drizzle schema changes live here. No migration files yet, no query code, no routes. This phase brings `server/src/schema/tables.ts` into its final shape; Phase 3 then generates the SQL that matches.

## Files

- `server/src/schema/tables.ts` (modify)

## Work

1. Ensure `uuid` is imported from `drizzle-orm/pg-core` alongside the existing `text`, `integer`, `timestamp`, `serial`, `pgTable`, `primaryKey`, `unique` imports.
2. Edit the `agents` table (currently at line 18). Apply these changes in order:
   - Add `id: uuid('id').primaryKey()` as the first field.
   - Remove `.primaryKey()` from the existing `name: text('name')` declaration.
   - Leave `project_id text notNull` as is — the `.references(...)` call comes in step 3.
   - Add a table-level `unique('agents_project_name_unique').on(table.projectId, table.name)` using the `(table) => [...]` callback form already used by `files`, `taskFiles`, `taskDependencies`, `roomMembers`, and `teamMembers` in the same file.
   - Add a comment above `status` enumerating the valid values: `idle | working | done | error | paused | stopping | deleted`.
   - Ensure `sessionToken` still has `.unique()` (it should — do not remove).
3. Add `.references(() => projects.id)` on the `project_id` column of all 9 data tables: `agents`, `ubtLock`, `ubtQueue`, `buildHistory`, `messages`, `tasks`, `files`, `rooms`, `teams`. Drop the `.default('default')` on each. The FK makes an implicit default unsafe; tests that relied on the default must pass an explicit `projectId` (updated in Phase 12).
4. Replace every text column that references an agent by name with a `uuid` FK to `agents.id`:
   - `tasks.claimedBy` (`text`, nullable) → `claimedByAgentId: uuid('claimed_by_agent_id').references(() => agents.id, { onDelete: 'restrict' })`, nullable.
   - `files.claimant` (`text`, nullable) → `claimantAgentId: uuid('claimant_agent_id').references(() => agents.id, { onDelete: 'restrict' })`, nullable.
   - `buildHistory.agent` (`text`, not nullable) → `agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'restrict' })`.
   - `ubtLock.holder` (`text`, nullable) → `holderAgentId: uuid('holder_agent_id').references(() => agents.id, { onDelete: 'restrict' })`, nullable.
   - `ubtQueue.agent` (`text`, not nullable) → `agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'restrict' })`.
   - `teamMembers.agentName` → `agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'restrict' })`. Update the composite PK from `(team_id, agent_name)` to `(team_id, agent_id)`.
5. For `messages.agent` and `build_history.agent` specifically — historical audit columns. Keep the old `agent text` column as a display-only legacy field for pre-migration rows, and add a new nullable `agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'restrict' })` column alongside. New writes populate `agentId`; the old column is retained untouched. Apply the same treatment to both tables. (For `messages.agent`, use the referential-vs-label decision recorded in Phase 1's audit; if the audit found it to be a free-form label, skip the rename and only add the new nullable `agentId` column.)
6. Apply the agent-only `room_members` change:
   - Add `id: uuid('id').primaryKey()` as the first field.
   - Remove the old `member text` column entirely.
   - Remove the old composite PK declaration on `(room_id, member)`.
   - Add `agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'restrict' })`.
   - Add a table-level `unique('room_members_room_agent_unique').on(table.roomId, table.agentId)` using the `(table) => [...]` callback form.
   - Keep `joinedAt` as is.
7. Apply the `chat_messages` authorship discriminator:
   - Remove the old `sender: text('sender').notNull()` column entirely.
   - Add `authorType: text('author_type').notNull()`. Values are restricted to `'agent'`, `'operator'`, `'system'` via a CHECK constraint added in the Phase 3 migration — Drizzle's schema DSL does not express CHECK constraints fluently.
   - Add `authorAgentId: uuid('author_agent_id').references(() => agents.id, { onDelete: 'restrict' })` — nullable. Populated only when `authorType === 'agent'`.
   - Keep `roomId`, `content`, `replyTo`, `createdAt`, and the existing `id serial primary key` unchanged.
   - The table-level CHECK `(authorType = 'agent' AND authorAgentId IS NOT NULL) OR (authorType IN ('operator', 'system') AND authorAgentId IS NULL)` is added in the Phase 3 migration.
8. Commit the schema declarations. Message: `Phase 2: Drizzle schema declarations for agent surrogate PK, FKs, soft-delete, and Option D room_members/chat_messages`.

## Acceptance criteria

- `server/src/schema/tables.ts` imports `uuid` from `drizzle-orm/pg-core`.
- The `agents` table has `id: uuid('id').primaryKey()` as its first field, no `.primaryKey()` on `name`, and a table-level `unique('agents_project_name_unique').on(projectId, name)`.
- All 9 data tables have `project_id` with `.references(() => projects.id)` and no `.default('default')`.
- Every cross-table agent reference is a `uuid` column with `.references(() => agents.id, { onDelete: 'restrict' })`.
- `messages.agent` and `build_history.agent` retain their old `text` columns (historical audit exception) and carry new nullable `agent_id uuid` columns alongside.
- `room_members` has `id uuid PK`, `agent_id uuid NOT NULL FK`, `unique(room_id, agent_id)`, and no `member` column.
- `chat_messages` has `author_type text NOT NULL`, `author_agent_id uuid FK` (nullable), and no `sender` column.
- `teamMembers` composite PK is `(team_id, agent_id)`.
- `npm run typecheck` from `server/` surfaces errors from call sites of the renamed columns — this is expected and is addressed in later phases. The schema file itself should typecheck cleanly in isolation (look for errors pointing at `tables.ts`, not at callers).
- Commit exists with the schema file change.
