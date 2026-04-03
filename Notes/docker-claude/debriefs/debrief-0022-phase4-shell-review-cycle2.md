# Debrief 0022 -- Phase 4 Shell Review Cycle 2 Fixes

## Task Summary

Fix five review findings from review cycle 2 for Phase 4 shell scripts (launch.sh and setup.sh).

## Changes Made

- **launch.sh** (line ~625): Changed compose project name in single-agent stop from `claude-${AGENT_NAME}` to `claude-${PROJECT_ID}-${AGENT_NAME}` to match all other compose project names in the file.
- **launch.sh** (compose environment): Added `HOOK_BUILD_INTERCEPT` environment variable to the generated docker-compose.yml environment section, alongside the existing `HOOK_CPP_LINT` line.
- **launch.sh** (exports): Added `export HOOK_BUILD_INTERCEPT` alongside `export HOOK_CPP_LINT`.
- **launch.sh** (parallel launch): Added `HOOK_BUILD_INTERCEPT="$HOOK_BUILD_INTERCEPT"` to the parallel launch env overrides alongside `HOOK_CPP_LINT`.
- **launch.sh** (launch_team_member): Changed jq expressions for `agentName` and `agentType` to use `// empty` instead of bare access, and added non-empty checks with descriptive error messages before the format validation regex checks.
- **setup.sh** (migration error): Changed bare `return` to `return 1` so callers can detect migration failure.
- **setup.sh** (migration guidance): Added cleanup guidance message after migration success, telling user how to delete the old `docker/current-root` branch.

## Design Decisions

- The `// empty` jq pattern returns empty string instead of the literal string "null" when a field is missing, which is the correct way to handle optional/missing fields in jq.
- Non-empty checks are placed before format validation so that missing fields get a clear "missing required field" error rather than a confusing "contains invalid characters" error on an empty string.

## Build & Test Results

- Shell syntax validation: PASS (`bash -n launch.sh && bash -n setup.sh`)
- TypeScript typecheck: PASS (`npx tsc --noEmit`)
- Server tests: pending (running in background)

## Open Questions / Risks

None. All changes are mechanical fixes matching the review findings exactly.

## Suggested Follow-ups

None.
