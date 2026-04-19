# Debrief 0173 -- Phase 2: Task creation accept and persist agentTypeOverride

## Task Summary

Implement Phase 2 of the task-agent-type-override plan: thread `agentTypeOverride` through the TypeScript API layer so that `POST /tasks`, `POST /tasks/batch`, `PATCH /tasks/:id`, task ingestion, and all task API responses accept and persist the field.

## Changes Made

- **server/src/routes/tasks-types.ts** -- Added `agentTypeOverride: string | null` to `TaskRow` interface. Added the field to `toTaskRow()` mapping and `formatTask()` output.
- **server/src/routes/tasks-files.ts** -- Added `agentTypeOverride?: string` to `TaskBody` interface. Added the key to `taskBodyKeys` and `patchBodyKeys` validation maps.
- **server/src/queries/tasks-core.ts** -- Added `agentTypeOverride?: string` to `InsertOpts`. Added `agentTypeOverride: string | null` to `PatchFields`. Threaded the field through `insert()` values and `patch()` set logic.
- **server/src/routes/tasks.ts** -- Imported `isValidAgentName` from `branch-naming.ts`. Added validation of `agentTypeOverride` in `POST /tasks`, `POST /tasks/batch`, and `PATCH /tasks/:id` handlers. Threaded the field through to `tasksCore.insert()` in both single and batch creation. Added the field to patch fields construction in PATCH handler. Validation rejects values that do not match `AGENT_NAME_RE` (alphanumeric, hyphens, underscores; 1-64 chars). Null clears the field.
- **server/src/task-ingest.ts** -- Imported `isValidAgentName`. Added frontmatter parsing that reads from either `agent_type_override` (snake_case) or `agentTypeOverride` (camelCase) keys. Invalid values are silently ignored (stored as null). Threaded the parsed value through to `tasksCore.insert()`.
- **server/src/routes/tasks.test.ts** -- Added 9 new tests: POST with/without agentTypeOverride, POST with invalid value, PATCH set/clear/invalid, batch with/without/invalid, and GET list inclusion.
- **server/src/task-ingest.test.ts** -- Added 4 new tests: snake_case key, camelCase key, invalid value ignored, missing value results in null.

## Design Decisions

- **Validation via `isValidAgentName`**: The plan specified importing from `branch-naming.ts`. The function already existed, so no wrapper was needed.
- **Snake_case frontmatter priority**: When both `agent_type_override` and `agentTypeOverride` keys exist in frontmatter, `agent_type_override` takes precedence (via `??` -- first non-nullish wins). This follows the convention of `acceptance_criteria` also using snake_case in frontmatter.
- **Invalid ingestion values silently ignored**: During ingestion, an invalid `agent_type_override` value is silently treated as undefined (stored as null). This matches the existing pattern for priority (non-integer defaults to 0) -- ingestion is a best-effort parse, not a strict validation gate.
- **PATCH null handling**: Setting `agentTypeOverride` to `null` in a PATCH clears the field. This parallels how `sourcePath` can be set to null.

## Build & Test Results

- **Build**: SUCCESS (`npm run build` clean)
- **Typecheck**: SUCCESS (`npm run typecheck` clean)
- **Tasks route tests**: 59/59 pass (50 pre-existing + 9 new)
- **Task ingest tests**: 15/16 pass (11 pre-existing + 4 new). The 1 failure ("different projectId does not dedup") is pre-existing -- it uses project IDs `project-a`/`project-b` that are not seeded in the test DB's `projects` table, violating the FK constraint. This failure exists on the base branch without any of these changes.
- **Tasks ingest route tests**: 4/4 pass

## Open Questions / Risks

- The pre-existing test failure in `task-ingest.test.ts` ("different projectId does not dedup") should be fixed separately -- it is not related to this phase.

## Suggested Follow-ups

- Phase 3 of the plan: wire `agentTypeOverride` into task claim logic so the override influences agent type selection.
- Fix the pre-existing `task-ingest.test.ts` failure for cross-project dedup test.
