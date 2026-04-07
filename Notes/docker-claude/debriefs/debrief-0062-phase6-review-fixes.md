# Debrief 0062 -- Phase 6 Review Fixes (Cycle 1)

## Task Summary

Fix all 10 issues identified by three reviewers in the Phase 6 task-ingest implementation. Issues span path security, variable shadowing, error isolation, missing tests, and shell script JSON injection.

## Changes Made

- **server/src/routes/tasks-ingest.ts** (modified): Added `IngestOpts` with `config: ScaffoldConfig`. Removed `projectId` from body schema (now uses only `request.projectId` from header plugin). Moved `getDb()` to plugin registration scope. Added `path.resolve` + configured project path validation for `tasksDir`. Added try/catch around `ingestTaskDir` with ENOENT handling and sanitized error messages.
- **server/src/index.ts** (modified): Pass `{ config }` when registering `tasksIngestPlugin`.
- **server/src/task-ingest.ts** (modified): Fixed variable shadowing (`parsed` -> `numericPriority`). Changed `let title` and `let priority` to `const`. Wrapped `matter()` call in try/catch with fallback to full-content-as-description. Added per-file error isolation in `ingestTaskDir` loop with error counting. Added `errors` field to `IngestDirResult`. Added comments documenting sequential execution rationale and `runReplan()` global scope.
- **server/src/task-ingest.test.ts** (modified): Added test for invalid YAML syntax within frontmatter delimiters, verifying fallback to filename-derived title.
- **scripts/ingest-tasks.sh** (modified): Replaced string-interpolated JSON with `jq -n --arg` to prevent JSON injection.

## Design Decisions

- Path validation uses `config.resolvedProjects[*].path` as allowed roots, checking that the resolved `tasksDir` starts with one of them. This is consistent with how the server knows about project directories.
- The YAML parse failure fallback uses the entire raw content as the description (including broken frontmatter markers), since extracting just the body portion from malformed YAML is unreliable.
- `priority` uses an IIFE to remain `const` while still having conditional logic -- avoids mutation.

## Build & Test Results

- Build: SUCCESS (`npm run build`)
- Tests: 10 passed, 0 failed (`npx tsx --test src/task-ingest.test.ts`)

## Open Questions / Risks

- The path validation checks against `config.resolvedProjects` paths. If a project is registered via `POST /projects` at runtime (not in `scaffold.config.json`), its path would not be in `resolvedProjects` and ingest would be rejected. This seems correct (only statically-configured projects should allow filesystem access) but is worth noting.

## Suggested Follow-ups

- Integration test for the `POST /tasks/ingest` route itself (not just the `ingestTaskFile` unit) to cover path validation and error handling at the HTTP level.
- Consider adding rate limiting or size limits to the ingest endpoint.
