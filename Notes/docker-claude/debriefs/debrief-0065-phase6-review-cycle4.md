# Debrief 0065 -- Phase 6 Review Cycle 4 Warning Fixes

## Task Summary

Fix 5 remaining warnings from the Phase 6 review to achieve clean approvals.

## Changes Made

- **server/src/index.ts** -- Merged duplicate imports from `./drizzle-instance.js` (lines 4 and 28) into a single import.
- **server/src/routes/tasks-ingest.ts** -- Fixed empty-path filter order: now filters on `p.path.length > 0` before calling `path.resolve()`, preventing `path.resolve('')` from returning cwd and defeating the filter. Also added catch for "Too many files" error from `ingestTaskDir`.
- **server/src/task-ingest.ts** -- Added `MAX_INGEST_FILES = 500` upper bound check after filtering `.md` files in `ingestTaskDir`.
- **server/src/routes/tasks-ingest.test.ts** -- Created route-level tests covering: relative path rejected (400), path outside project roots rejected (400), non-existent directory rejected (400), valid directory returns correct ingested result shape.
- **scripts/ingest-tasks.sh** -- Added comment documenting why `export PROJECT_ID` is required (safety W1 note).

## Design Decisions

- The "Too many files" error is caught by message prefix match (`err.message.startsWith('Too many files:')`) in the route handler to return a 400 with the descriptive message rather than the generic "Failed to ingest tasks".
- Route tests use `mkdtemp` for the valid-path test case and configure `resolvedProjects.default.path` to point at the temp directory so the path validation passes.

## Build & Test Results

- Build: SUCCESS (`npm run build`)
- `task-ingest.test.ts`: 12 passed, 0 failed
- `tasks-ingest.test.ts` (route): 4 passed, 0 failed
- `bash -n scripts/ingest-tasks.sh`: clean

## Open Questions / Risks

None.

## Suggested Follow-ups

None -- these were the final warnings in the review cycle.
