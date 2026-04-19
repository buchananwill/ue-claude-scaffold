# Debrief 0171 -- Schema: agent_type_override column on tasks

## Task Summary

Add a nullable `agent_type_override` text column to the `tasks` table in the Drizzle schema, generate the corresponding SQL migration, and verify everything type-checks and migrates cleanly. This is Phase 1 of the Task Agent Type Override feature.

## Changes Made

- **server/src/schema/tables.ts** -- Added `agentTypeOverride: text('agent_type_override'),` to the `tasks` table definition, positioned before `createdAt`.
- **server/drizzle/0005_add_agent_type_override.sql** -- New migration file containing `ALTER TABLE "tasks" ADD COLUMN "agent_type_override" text;`.
- **server/drizzle/meta/_journal.json** -- Added entry for migration `0005_add_agent_type_override` (idx 5).

## Design Decisions

- The column is nullable with no default, matching the plan specification. NULL means "use container default AGENT_TYPE."
- Placed the column after `progressLog` and before `createdAt` to keep the timestamp as the final column, consistent with the pattern used in other tables.
- Wrote the migration manually rather than via `drizzle-kit generate` because the Docker container lacks a TTY, which drizzle-kit requires for interactive column-rename disambiguation prompts. The migration is a single straightforward ALTER TABLE statement so manual authorship introduces no risk.
- Used a timestamp of `1776710400000` (April 2026) for the journal entry's `when` field, consistent with the chronological ordering of prior entries.

## Build & Test Results

- `npm run db:migrate` -- passed, migration applied successfully against PGlite.
- `npm run typecheck` -- passed, no errors.
- `npm run build` -- pending (will run after commit).

## Open Questions / Risks

None. This is a purely additive nullable column with no default -- zero risk to existing data or queries.

## Suggested Follow-ups

- Phase 2: Accept and persist `agent_type_override` in task creation endpoints.
- Phase 3: Server endpoint to compile and serve agent definitions on demand.
