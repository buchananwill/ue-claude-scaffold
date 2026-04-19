# Debrief 0172 -- agent_type_override CHECK constraint

## Task Summary

Address safety review finding W1: the `agentTypeOverride` column in the tasks table was an unbounded text field with no CHECK constraint. Since this value will be used as an `AGENT_TYPE` env-var value or in branch naming, a DB-level format constraint is required to prevent injection of unsafe values.

## Changes Made

- **server/src/schema/tables.ts** -- Added `tasks_agent_type_override_check` CHECK constraint on the `agentTypeOverride` column. The constraint allows NULL (column is nullable) or matches the pattern `^[a-zA-Z0-9_-]{1,64}$`, consistent with the existing `projects_id_check` constraint.
- **server/drizzle/0005_add_agent_type_override.sql** -- Added ALTER TABLE statement to add the CHECK constraint to the migration file.
- **server/src/queries/test-utils.ts** -- Added the CHECK constraint to the tasks CREATE TABLE DDL block used in test setup.

## Design Decisions

- Used the same regex pattern (`^[a-zA-Z0-9_-]{1,64}$`) as the `projects.id` CHECK constraint, since both serve a similar purpose (safe identifier values that will be used in shell/env contexts).
- Used `IS NULL OR` prefix to allow the nullable column to accept NULL values without triggering the constraint.
- Named the constraint `tasks_agent_type_override_check` following the existing convention of `{table}_{column}_check`.

## Build & Test Results

- Build: SUCCESS (`npm run build` in server/)
- Tests: 104 passed, 0 failed (all four task test suites)

## Open Questions / Risks

None. The change is minimal and follows established patterns.

## Suggested Follow-ups

None.
