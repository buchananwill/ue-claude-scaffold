# Debrief 0079 -- Phase 10 Review Cycle 3 Fixes

## Task Summary

Fix all review findings from Phase 10 cycle 3. One BLOCKING issue (python3 not installed in container) and five WARNING-level issues across entrypoint.sh, exit-classify route, and exit-classifier module.

## Changes Made

- **container/entrypoint.sh** -- `_detect_abnormal_exit`: Replaced python3-based JSON construction with `jq -n --arg/--argjson`. Replaced python3 response parsing with `jq -r` for both `.abnormal` and `.reason` fields.
- **container/entrypoint.sh** -- `_post_abnormal_shutdown_message`: Replaced python3 JSON construction with `jq -n` using `--arg` for all string values. Added `trap 'rm -f "$tmpfile"' RETURN` after mktemp (Safety W1). Removed manual `rm -f` at end since trap handles cleanup.
- **server/src/routes/exit-classify.ts** -- Added `maxLength: 128` to name param schema (Safety W2). Added comment about name param being for log correlation only (Style W1). Added schema sync comment above body schema (Style W2).
- **server/src/exit-classifier.ts** -- Added `Math.floor()` to `elapsedSeconds` and `outputLineCount` at the start of `classifyExit()` (Correctness W1).

## Design Decisions

- In `_post_abnormal_shutdown_message`, the message string is constructed in bash before passing to jq via `--arg`, keeping the jq template clean.
- The `trap ... RETURN` pattern replaces the manual `rm -f` at end of `_post_abnormal_shutdown_message`, consistent with how `_detect_abnormal_exit` already handles cleanup.

## Build & Test Results

- Shell syntax validation: PASS (`bash -n entrypoint.sh`)
- Server build: PASS (`npm run build`)
- exit-classifier unit tests: 19/19 PASS
- exit-classify route integration tests: 6/6 PASS
- Pre-existing test failure in tasks.test.ts due to git config in container environment (unrelated)

## Open Questions / Risks

None.

## Suggested Follow-ups

None -- all cycle 3 findings addressed.
