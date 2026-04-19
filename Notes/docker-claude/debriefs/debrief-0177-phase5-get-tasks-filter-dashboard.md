# Debrief 0177 -- Phase 5: GET /tasks agentTypeOverride filter and dashboard column

## Task Summary

Implement Phase 5 of the task-agent-type-override plan: add an `agentTypeOverride` query filter to `GET /tasks` and add an "Agent Type" column to the dashboard tasks table.

## Changes Made

- **server/src/routes/tasks.ts** -- Added `agentTypeOverride` to `TaskListQueryInput` and `ParsedTaskListQuery` interfaces. Added parsing via `parseCommaFilter` with validation using `isValidAgentName` (accepting `__default__` as the sentinel for null matching). Imported `isValidAgentName` from `branch-naming.js`. Updated `GET /tasks` Querystring type and filter options to thread the parsed array through to `tasks-core`.
- **server/src/queries/tasks-core.ts** -- Added `agentTypeOverride?: string[]` to `ListOpts` and `CountOpts` interfaces. Added filter condition logic in `buildFilterConditions` mirroring the existing `__unassigned__` pattern for the `agent` filter: splits out `__default__` sentinel, combines `isNull`/`eq`/`inArray` via `or`.
- **dashboard/src/api/types.ts** -- Added `agentTypeOverride: string | null` to the `Task` interface.
- **dashboard/src/components/TasksPanel.tsx** -- Added "Agent Type" column header in the table. Added table cell rendering: shows a violet `Badge` when override is set, dimmed "default" text when null.
- **dashboard/src/components/TaskDetailRow.tsx** -- Updated `colSpan` from 8 to 9 to match new column count. Added "Agent Type Override" display in the detail row with violet badge.
- **dashboard/src/hooks/useTaskFilters.test.ts** -- Added `agentTypeOverride: null` to the `makeTask` helper to satisfy the updated `Task` interface. Fixed pre-existing lint error (constant binary expression `null !== null` on line 509).
- **server/src/routes/tasks.test.ts** -- Added 5 new integration tests for the agentTypeOverride filter: exact match, `__default__` sentinel for null, combined filter, invalid value 400, and empty segments 400.

## Design Decisions

- Mirrored the `agent` / `__unassigned__` pattern exactly as specified: `agentTypeOverride` uses `__default__` as the sentinel, `parseCommaFilter` for parsing, `isValidAgentName` for validation (same regex as `AGENT_NAME_RE`).
- Placed the "Agent Type" column between "Agent" and "Created" in the table for logical grouping.
- Used violet color for the override badge to visually distinguish it from status badges (which use various colors).
- Displayed "default" in dimmed text for null overrides rather than an em-dash, since "default" communicates the semantics (the container's default `AGENT_TYPE` will be used).

## Build & Test Results

- Server build: SUCCESS (`npm run build` clean)
- Dashboard build: SUCCESS (`npm run build` clean)
- Server tests: 66 passed, 0 failed (including 5 new agentTypeOverride filter tests)

## Open Questions / Risks

None identified. The implementation follows established patterns exactly.

## Suggested Follow-ups

- The `agentTypeOverride` column is not yet sortable in the dashboard table (no `SortHeader`). Could be added if needed.
- A filter popover in the dashboard column header (similar to the Agent filter) could be added for client-side filtering by agent type.
