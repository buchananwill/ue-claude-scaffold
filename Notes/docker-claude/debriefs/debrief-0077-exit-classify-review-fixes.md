# Debrief 0077: Phase 10 Exit Classifier Review Fixes (Cycle 1)

## Task Summary
Fix all review findings from the Phase 10 (exit classifier) review cycle 1, covering blocking fixes (route URL, logTail bounds, shell injection) and warning fixes (Python null handling, boolean normalization, missing test fixtures, documentation, audit logging, schema tightening).

## Changes Made
- **server/src/routes/exit-classify.ts**: Renamed route from `/agents/:name/exit:classify` to `/agents/:name/exit-classify` (B1). Added `maxLength: 65536` to `logTail` schema (Safety B1). Changed `elapsedSeconds` to `type: 'integer'` with `maximum: 86400` (Safety W2). Added comment documenting `outputLineCount` semantics (Correctness W2). Added `request.log.info` call using `request.params.name` for audit tracing (Safety W1).
- **server/src/routes/exit-classify.test.ts**: Updated describe string and all test URLs from `exit:classify` to `exit-classify` (B1).
- **container/entrypoint.sh**: Updated curl URL from `exit:classify` to `exit-classify` (B1). Rewrote `_post_abnormal_shutdown_message` to use python3 JSON encoding instead of heredoc string interpolation (Safety B2). Fixed `d.get('reason','unknown')` to `d.get('reason') or 'unknown'` to handle JSON null (Style W1). Normalized `is_abnormal` to lowercase via `str(...).lower()` in python3 (Style W2).
- **server/src/exit-classifier.ts**: Added JSDoc comment to `outputLineCount` field in `ClassifyExitInput` (Correctness W2).
- **server/src/exit-classifier.test.ts**: Added three new test cases for `session limit reached`, `token exhausted`, and `max token reached for this request` (Correctness W1).

## Design Decisions
- Used `str(d.get('abnormal', False)).lower()` in python3 for boolean normalization rather than piping through `tr`, keeping the logic in one place.
- For `_post_abnormal_shutdown_message`, matched the existing pattern from `_detect_abnormal_exit` by using python3 with `sys.argv` for safe JSON construction.

## Build & Test Results
- Build: SUCCESS (`npm run build`)
- Tests: 25 passed, 0 failed (exit-classifier.test.ts + exit-classify.test.ts)
- Shell validation: `bash -n entrypoint.sh` passed

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
