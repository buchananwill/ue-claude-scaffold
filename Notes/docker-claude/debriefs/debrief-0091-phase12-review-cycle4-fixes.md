# Debrief 0091 -- Phase 12 Review Cycle 4 Fixes

## Task Summary
Fix two review findings from Phase 12 cycle 4: a correctness bug where `PUMP_STATUS="circuit_break"` was clobbered by unconditional `PUMP_STATUS="stop"`, and a safety warning where zero values were accepted for `MAX_TURNS` and `WORKER_POLL_INTERVAL`.

## Changes Made
- **container/lib/pump-loop.sh** -- Guard the `PUMP_STATUS="stop"` assignment in `_pump_iteration` so it does not overwrite `circuit_break` set by `_poll_and_claim_task`.
- **container/lib/env.sh** -- Changed regex for `MAX_TURNS` and `WORKER_POLL_INTERVAL` from `^[0-9]+$` to `^[1-9][0-9]*$` to reject zero values.

## Design Decisions
- Used regex `^[1-9][0-9]*$` rather than a separate arithmetic check -- keeps the validation pattern consistent with the existing style and is a single-line change.

## Build & Test Results
Pending `bash -n` validation.

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
