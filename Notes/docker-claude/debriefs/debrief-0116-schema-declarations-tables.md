# Debrief 0116 — Phase 2: Schema declarations in tables.ts

## Task Summary

Implement Phase 2 of the schema hardening V2.5 plan: update the Drizzle schema declarations in `server/src/schema/tables.ts` to introduce agent surrogate UUID primary keys, foreign key references to `projects.id`, agent UUID FKs replacing text agent-name references, and restructured `room_members`/`chat_messages` tables.

## Changes Made

- **server/src/schema/tables.ts** — Complete schema rewrite per plan:
  - Added `uuid` and `unique` to imports from `drizzle-orm/pg-core`.
  - `agents`: Added `id: uuid('id').primaryKey()`, removed `.primaryKey()` from `name`, added `.references(() => projects.id)` on `projectId`, added table-level unique constraint on `(projectId, name)`, added status values comment.
  - `ubtLock`: Changed PK from `projectId` to `hostId: text('host_id').primaryKey().default('local')`, replaced `holder` with `holderAgentId: uuid` FK to agents, removed `projectId`. Updated table comment.
  - `ubtQueue`: Replaced `agent: text` with `agentId: uuid` FK to agents, removed `projectId`. Updated table comment.
  - `buildHistory`: Added `.references(() => projects.id)` on `projectId`, removed `.default('default')`, kept legacy `agent` text column, added new `agentId: uuid` FK to agents.
  - `messages`: Added `.references(() => projects.id)` on `projectId`, removed `.default('default')`, kept legacy `fromAgent` text column, added new `agentId: uuid` FK to agents.
  - `tasks`: Added `.references(() => projects.id)` on `projectId`, removed `.default('default')`, replaced `claimedBy: text` with `claimedByAgentId: uuid` FK to agents.
  - `files`: Added `.references(() => projects.id)` on `projectId`, removed `.default('default')`, replaced `claimant: text` with `claimantAgentId: uuid` FK to agents.
  - `rooms`: Added `.references(() => projects.id)` on `projectId`, removed `.default('default')`.
  - `teams`: Added `.references(() => projects.id)` on `projectId`, removed `.default('default')`.
  - `roomMembers`: Added `id: uuid('id').primaryKey()`, removed `member: text`, removed composite PK on `(roomId, member)`, added `agentId: uuid` FK to agents, added unique constraint on `(roomId, agentId)`.
  - `chatMessages`: Removed `sender: text`, added `authorType: text('author_type').notNull()`, added `authorAgentId: uuid` FK to agents (nullable).
  - `teamMembers`: Replaced `agentName: text` with `agentId: uuid` FK to agents, updated composite PK from `(teamId, agentName)` to `(teamId, agentId)`.

## Design Decisions

- All agent UUID FKs use `onDelete: 'restrict'` to prevent accidental agent deletion while references exist.
- Legacy text columns (`fromAgent` in messages, `agent` in buildHistory) are kept for pre-migration row display.
- `ubtLock` and `ubtQueue` had `projectId` removed entirely per plan (they are host-global / agent-global).
- No CHECK constraint added for `authorType` in `chatMessages` — plan explicitly defers this to Phase 3 migration.

## Build & Test Results

- `npx tsc --noEmit` reports zero errors in `tables.ts` itself.
- Errors exist in other files (queries, routes, tests) that reference renamed/removed columns — expected and will be fixed in later phases.

## Open Questions / Risks

- The `agents.id` UUID column has no `.defaultRandom()` — callers must supply a UUID. This is intentional per the plan but means all insert sites need updating.
- `roomMembers.id` also requires a caller-supplied UUID.
- The `messages.claimedBy` column was left as `text` (not converted to UUID FK). The plan did not mention converting it, and it may refer to agent names in a display context.

## Suggested Follow-ups

- Phase 3: SQL migration to match these schema declarations.
- Update all query/route files that reference renamed columns (claimedBy -> claimedByAgentId, claimant -> claimantAgentId, etc.).
- Add `.defaultRandom()` to UUID PKs if the team prefers server-generated UUIDs.
