# Debrief 0066 -- Phase 6 Final Warning Fixes (Cycle 5)

## Task Summary
Fix 3 final correctness warnings from review: remove ingested guard on runReplan, catch ENOTDIR in tasks-ingest route, and guard jq null string in ingest-tasks.sh.

## Changes Made
- **server/src/task-ingest.ts**: Removed `if (ingested > 0)` guard so `runReplan()` is called unconditionally.
- **server/src/routes/tasks-ingest.ts**: Extended ENOENT catch to also match ENOTDIR using array includes check. Updated error message.
- **server/src/routes/tasks-ingest.test.ts**: Updated assertion to match new error message ("not a directory or not accessible" instead of "not found").
- **scripts/ingest-tasks.sh**: Added `// 0` jq default to errors extraction to prevent "null" string comparison failure.

## Design Decisions
- Updated the test assertion to match the new ENOTDIR error message rather than keeping the old message, since the new message is more accurate for the combined error case.

## Build & Test Results
- Build: SUCCESS (`npm run build`)
- task-ingest.test.ts: 12/12 passed
- tasks-ingest.test.ts: 4/4 passed
- Shell syntax: valid

## Open Questions / Risks
None.

## Suggested Follow-ups
None -- these were the final review warnings.
