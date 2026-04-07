# Debrief 0078 -- Exit Classify Review Cycle 2 Fixes

## Task Summary

Fix all six review findings from Phase 10 cycle 2 covering style, safety, and correctness issues in the exit-classifier route, module, and entrypoint.sh integration.

## Changes Made

- **server/src/routes/exit-classify.ts**: Added explicit `Promise<ClassifyExitResult>` return type on handler; imported `ClassifyExitResult`; added `maximum: 10000000` to `outputLineCount` schema.
- **server/src/exit-classifier.ts**: Added JSDoc on `elapsedSeconds` field documenting the integer constraint.
- **container/entrypoint.sh**: Changed `_post_abnormal_shutdown_message` to use `${AGENT_NAME}` channel instead of hardcoded `'general'`; added `trap 'rm -f "$tmpfile"' RETURN` in `_detect_abnormal_exit` and removed explicit `rm -f` calls; truncated `log_tail` with `head -c 50000` to stay within server maxLength.

## Design Decisions

- Used `RETURN` trap for tmpfile cleanup which is bash-specific but consistent with the script's existing use of bash features (process substitution, `[[ ]]`).
- Passed `${AGENT_NAME}` as the channel to match the pattern used by other message posts in the file.

## Build & Test Results

- Server build: SUCCESS (`npm run build`)
- Shell syntax check: SUCCESS (`bash -n entrypoint.sh`)
- exit-classify route tests: 6/6 pass
- exit-classifier unit tests: 19/19 pass
- Other test failures (tasks.test.ts) are pre-existing git config issues unrelated to these changes.

## Open Questions / Risks

None.

## Suggested Follow-ups

None.
