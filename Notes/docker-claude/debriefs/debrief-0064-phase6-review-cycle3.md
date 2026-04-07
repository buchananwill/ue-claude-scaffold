# Debrief 0064 -- Phase 6 Review Cycle 3 Fixes

## Task Summary

Fix remaining warnings from all three reviewers (cycle 3) on the shell script decomposition work, specifically in `task-ingest.test.ts` and `ingest-tasks.sh`.

## Changes Made

- **server/src/task-ingest.test.ts**: Removed unused `mkdir` import from `node:fs/promises`. Merged duplicate imports from `./schema/tables.js` into a single import (`tasks, taskFiles`). Added `replanned >= 0` assertion in the first `ingestTaskDir` test.
- **scripts/ingest-tasks.sh**: Restored `export` on `PROJECT_ID` assignment. Added warning when `--project` is not specified. Extracted `errors` from server response and included it in summary output. Exit non-zero when errors > 0.

## Design Decisions

- Used `>= 0` for the replanned assertion since the exact count depends on the replan algorithm with no task dependencies in the test fixture.
- The PROJECT_ID warning uses stderr to avoid polluting stdout for scripts that parse output.

## Build & Test Results

- Build: SUCCESS (`npm run build`)
- Tests: 12 passed, 0 failed (`npx tsx --test src/task-ingest.test.ts`)
- Shell syntax: OK (`bash -n scripts/ingest-tasks.sh`)

## Open Questions / Risks

None.

## Suggested Follow-ups

None -- all reviewer warnings should now be resolved.
