# Debrief 0183 -- Phase 4 Safety and Correctness Review Fixes

## Task Summary

Fix 2 BLOCKING and 3 WARNING findings from safety + correctness reviews of Phase 4 (container fetch and cache agent definitions at claim time).

## Changes Made

- **container/lib/agent-fetch.sh** -- Added `^[a-zA-Z0-9_-]+$` allowlist check after the empty-string guard in `_ensure_agent_type` [B1]. Replaced `echo "$compiled_md"` with `printf '%s\n' "$compiled_md"` and added a 512KB size guard before writing [B2]. Moved `--max-time 15` before `--` option terminator in the curl call [W2].
- **container/lib/pump-loop.sh** -- Added allowlist validation of `CURRENT_TASK_AGENT_TYPE` immediately after extraction from task JSON, resetting to empty on failure [B1]. Expanded the early-return reset block in `_pump_iteration` to clear all 7 task variables (was only clearing 2) [W1-correctness].
- **container/lib/run-claude.sh** -- Added defence-in-depth allowlist guard on `effective_agent_type` before constructing CLAUDE_ARGS, protecting the single-task path [W1-safety].

## Design Decisions

- The allowlist regex `^[a-zA-Z0-9_-]+$` matches the existing pattern used for `AGENT_NAME` and `PROJECT_ID` in `env.sh`.
- Size check uses `printf '%s\n' | wc -c` rather than `${#var}` to get byte count (handles multi-byte correctly).
- The pump-loop validation sets the variable to empty string on failure (rather than returning 1) because the task claim itself is still valid -- only the override is rejected. The task will run with the default agent type.

## Build & Test Results

Pending initial build.

## Open Questions / Risks

None. All fixes are mechanical safety hardening following reviewer instructions.

## Suggested Follow-ups

None.
