# Debrief 0093 -- Phase 13 Review Cycle 1 Fixes

## Task Summary
Fix all review findings from Phase 13 cycle 1 covering blocking issues (B1-B2, Safety B1-B2, Correctness B1) and warning-level issues (Style W3-W4, Safety W2-W3, Correctness W1/W3-W5).

## Changes Made
- **launch.sh**: Changed `_team_flag` from `"--team"` to `"true"` (B1). Converted all `$COMPOSE_CMD` to `"${COMPOSE_CMD[@]}"` array usage (B2). Removed redundant `AGENT_MODE=pump` from parallel env overrides (W4). Removed double `compose build --no-cache` on `--fresh` (W3). Fixed Logs echo to use `${COMPOSE_CMD[*]}` (W4).
- **scripts/lib/compile-agents.sh**: Renamed parameter to `_ca_team_mode`, compare with `"true"` (B1).
- **scripts/lib/compose-detect.sh**: Changed `COMPOSE_CMD` from string to bash array (B2/Safety B1).
- **scripts/lib/launch-container.sh**: Updated `$COMPOSE_CMD` to `"${COMPOSE_CMD[@]}"` (B2).
- **stop.sh**: Converted `COMPOSE_CMD` to array and all call sites to `"${COMPOSE_CMD[@]}"` (B2).
- **scripts/lib/parse-launch-args.sh**: Added `--parallel` integer validation 1-20 (Safety B2). Extended `--brief` to reject paths starting with `.` (Safety W2). Added `--no-agent` to usage help (Correctness W1).
- **container/docker-compose.template.yml**: Added `AGENT_MODE` env var (Correctness B1). Updated comment (Style W3).
- **scripts/lib/resolve-hooks.sh**: Replaced `echo` with `printf '%s'` for JSON piping (Safety W3).
- **scripts/lib/print-resolved-config.sh**: Added `nullglob` around dynamic-agents glob loop (Correctness W5).

## Design Decisions
- For stop.sh, applied the same COMPOSE_CMD array pattern even though it was not explicitly listed, since it uses the same pattern and would break if only compose-detect.sh changed.
- Used `${COMPOSE_CMD[*]}` (not `[@]`) inside echo strings for display purposes, which expands to a single string with spaces -- appropriate for human-readable output.

## Build & Test Results
All shell files pass `bash -n` syntax validation: launch.sh, stop.sh, setup.sh, status.sh, all scripts/lib/*.sh, scripts/*.sh, container hooks, and entrypoint.sh.

## Open Questions / Risks
None identified.

## Suggested Follow-ups
None.
