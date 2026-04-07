# Debrief 0089 - Phase 12 Review Cycle 2 Fixes

## Task Summary
Fix all review findings from Phase 12 cycle 2: two blocking style issues, one blocking safety issue, and three warning-level fixes across container shell libraries.

## Changes Made
- **container/lib/registration.sh**: Added `local SMOKE_RESPONSE SMOKE_STATUS smoke_payload` to `_smoke_test_messages()`. Replaced hardcoded JSON string with jq-constructed payload for consistency with the rest of the codebase.
- **container/lib/pump-loop.sh**: Added `local TASK_EXIT` to `_pump_iteration()`. Added validation guard for `CURRENT_TASK_ID` after extraction from server response (regex check, circuit-breaks on malformed ID). Added `ABNORMAL_SHUTDOWN="stop_requested"` before `exit 0` in `_poll_and_claim_task` stop detection block.
- **container/lib/env.sh**: Added `PROJECT_ID` validation guard matching the same pattern as `AGENT_NAME` (`^[a-zA-Z0-9_-]+$`).

## Design Decisions
- The `CURRENT_TASK_ID` validation uses `PUMP_STATUS="circuit_break"` with `return` rather than `exit 1` so the pump loop's circuit breaker logic handles it consistently.
- Used `jq -n` for the smoke test payload since the message is static (no variable interpolation needed), keeping it simple.

## Build & Test Results
All 23 project shell files pass `bash -n` syntax validation. No compilation step needed (shell-only changes).

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
