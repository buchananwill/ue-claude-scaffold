# Debrief 0103 -- Phase 15 Review Cycle 4 Fixes

## Task Summary
Fix all BLOCKING and WARNING findings from the Phase 15 cycle 4 review of status.sh decomposition work.

## Changes Made

- **status.sh** (~line 49): Added guard for `--project` with missing argument to prevent unbound variable crash under `set -u` (B1).
- **status.sh** (~lines 228, 232): Replaced `echo "$payload" | jq` with `printf '%s' "$payload" | jq` to avoid backslash interpretation (W2).
- **status.sh** (~line 241): Tightened CURSOR validation from `!= "null" && -n` to `^[0-9]+$` regex check (W3).
- **server/src/queries/messages.ts** (line 59): Added `conditions.length > 0 ? ... : undefined` guard to polling-mode `and(...conditions)` for consistency with paging path (W1).
- **server/src/routes/status.ts** (lines 29-35): Added explicit validation for `taskLimit` -- returns 400 for non-positive-integer values instead of silently clamping (W4).
- **server/src/routes/status.test.ts** (since=0 test): Added explicit `projectId: 'default'` to message inserts and `x-project-id` header to inject call (W5).

## Design Decisions
- W4: taskLimit validation rejects floats (e.g. 2.5) and zero/negative values with a 400. Valid integers above 200 are still silently clamped to 200 (upper bound clamping is expected server behavior, not an error).
- W3: The regex `^[0-9]+$` rejects "null", empty string, negative numbers, and floats in one check, which is stricter than the previous two-condition guard.

## Build & Test Results
- `npm run build` in server/: SUCCESS
- `npx tsx --test src/routes/status.test.ts`: 10/10 PASS
- `bash -n status.sh`: SUCCESS (syntax valid)

## Open Questions / Risks
None.

## Suggested Follow-ups
- Consider adding a test case for invalid taskLimit values (e.g. `taskLimit=abc`, `taskLimit=-1`) to status.test.ts.
