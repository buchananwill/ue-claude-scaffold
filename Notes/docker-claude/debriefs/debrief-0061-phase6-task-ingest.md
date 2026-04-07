# Debrief 0061 -- Phase 6: Server-side Task Ingest

## Task Summary

Move markdown task file parsing (frontmatter + body) from the shell script `scripts/ingest-tasks.sh` into the TypeScript server. This covers steps 33-38 of the shell script refactor plan: installing gray-matter, creating the ingest module with tests, adding a route, and rewriting the shell script as a thin shim.

## Changes Made

- **server/package.json** -- Added `gray-matter` dependency (v4.0.3).
- **server/src/task-ingest.ts** -- Created. Exports `ingestTaskFile()` and `ingestTaskDir()`. Uses gray-matter for frontmatter parsing, deduplicates by sourcePath+projectId, validates priority as integer, falls back title to filename, links files via composition module, calls runReplan after batch ingest.
- **server/src/task-ingest.test.ts** -- Created. 9 tests covering: happy path with all fields, title fallback, non-integer priority, float priority, files list parsing, dedup on re-ingest, malformed frontmatter, cross-project non-dedup, missing priority default.
- **server/src/routes/tasks-ingest.ts** -- Created. Fastify plugin for `POST /tasks/ingest` with JSON schema validation, path traversal check, delegates to `ingestTaskDir`.
- **server/src/routes/index.ts** -- Added `tasksIngestPlugin` export.
- **server/src/index.ts** -- Registered `tasksIngestPlugin` on the Fastify server.
- **scripts/ingest-tasks.sh** -- Rewritten as a ~55-line shim. Parses flags, validates directory, delegates to `POST /tasks/ingest` via `_post_json`. Removed `parse_frontmatter` function and state-file logic.

## Design Decisions

- `ingestTaskFile` takes file content as a string parameter (not reading from disk) for testability per plan requirements.
- `ingestTaskDir` reads from the filesystem and is the only function doing I/O, keeping the core logic pure.
- Priority validation rejects floats (3.7 -> 0) since the plan says "validated as integer". `Number.isInteger()` handles this cleanly.
- The route accepts `projectId` in the body but falls back to `request.projectId` from the X-Project-Id header, following existing project-scoping patterns.
- Dedup uses the Drizzle query builder directly against the tasks table rather than going through tasks-core, since tasks-core has no "find by sourcePath" function.

## Build & Test Results

- **Build**: SUCCESS (`npm run build` -- clean, no errors)
- **Tests**: 9/9 PASS (`npx tsx --test src/task-ingest.test.ts`)
- **Shell syntax**: PASS (`bash -n scripts/ingest-tasks.sh`)

## Open Questions / Risks

- The shell shim uses `_post_json` which requires `jq` and `curl` on the host. This is consistent with the existing approach.
- `ingestTaskDir` calls `runReplan()` which uses `tryGetDb()` -- in the route context this works fine, but if called standalone without Drizzle init, replan silently returns 0. This is acceptable.
- The route does not check whether `tasksDir` exists before calling `ingestTaskDir` -- a missing directory will produce an ENOENT error from `readdir`. This could be improved with a pre-check, but is consistent with server-side error handling patterns (Fastify will return 500).

## Suggested Follow-ups

- Add a route-level test for `POST /tasks/ingest` (e.g., in `src/routes/tasks-ingest.test.ts`) that tests the HTTP layer including validation and path traversal blocking.
- Consider adding an `--force` flag to the shell shim to allow re-ingesting tasks that were previously skipped.
