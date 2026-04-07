# Debrief 0063 -- Phase 6 Review Cycle 2 Fixes

## Task Summary

Fix all remaining issues flagged by three reviewers on the shell script decomposition Phase 6 (task ingestion).

## Changes Made

- **server/src/routes/tasks-ingest.ts** -- Rewrote path validation: require absolute path, normalize allowedRoots with path.resolve(), add trailing separator boundary check, add empty allowedRoots guard, removed redundant `..` substring check.
- **server/src/task-ingest.ts** -- Sanitized per-file error messages in the catch block to use errno codes instead of raw err.message. Added JSDoc on ingestTaskFile documenting filePath as a host-specific dedup key.
- **server/src/task-ingest.test.ts** -- Removed unused `and` import from drizzle-orm. Added ingestTaskDir integration test suite with two tests: one for .md filtering and ingestion, one for dedup on re-ingest.
- **scripts/ingest-tasks.sh** -- Changed `export PROJECT_ID="$2"` to plain `PROJECT_ID="$2"`.

## Design Decisions

- The path validation now follows a single clear gate: require absolute -> resolve -> check against normalized roots with separator boundary. This eliminates the `..` check entirely since absolute + startsWith-with-separator is sufficient.
- Per-file error sanitization uses errno code when available, falls back to a generic message. This avoids leaking filesystem paths in API responses.

## Build & Test Results

Pending initial build.

## Open Questions / Risks

None.

## Suggested Follow-ups

None.
