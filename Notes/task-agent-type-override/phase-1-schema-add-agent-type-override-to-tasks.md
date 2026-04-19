 
# Phase 1 — Schema: add agent_type_override to tasks

Part of [Task Agent Type Override](./_index.md). See the index for the shared goal and context — this phase body assumes them.

**Outcome:** The `tasks` table has an `agent_type_override` column (nullable text). The column exists in the Drizzle
schema and a SQL migration.

**Types / APIs:**

```ts
// schema/tables.ts — tasks table, new column:
agentTypeOverride: text('agent_type_override'),
```

**Work:**

- Add `agentTypeOverride` to the `tasks` table definition in `server/src/schema/tables.ts`.
- Run `npm run db:generate` to produce the SQL migration in `server/drizzle/`.
- Run `npm run db:migrate` to verify the migration applies cleanly.

**Verification:** `npm run typecheck` passes. The generated migration file contains
`ALTER TABLE tasks ADD COLUMN agent_type_override text`.
