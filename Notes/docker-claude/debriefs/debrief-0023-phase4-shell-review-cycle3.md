# Debrief 0023 -- Phase 4 Shell Review Cycle 3 Fixes

## Task Summary

Fix four review findings from Phase 4 review cycle 3, all in shell scripts (launch.sh and setup.sh): jq null bypass issues, an unbound variable, and a migration return code inconsistency.

## Changes Made

- **launch.sh**: Changed `jq -r '.role'` to `jq -r '.role // empty'` in `launch_team_member()` to prevent null becoming literal string "null" (Safety B1).
- **launch.sh**: Changed `jq -r '.id'` and `jq -r '.name'` to use `// empty` for TEAM_ID and TEAM_NAME, added non-empty validation checks with descriptive error messages (Safety B2).
- **launch.sh**: Initialized `PROJECT_AGENT_TYPE=""` alongside `PROJECT_HOOK_BUILD` and `PROJECT_HOOK_LINT` before the if/elif/else config resolution block, preventing potential unbound variable error in legacy path (Correctness B1).
- **setup.sh**: Changed `return 1` to `return 0` in the migration error handler to match the error-continuation pattern established by `_create_bare_and_root` (Correctness W1).

## Design Decisions

- For `_MEMBER_ROLE`, only fixed the jq expression without adding a non-empty check, since role is optional per the fix instructions.
- For `TEAM_ID` and `TEAM_NAME`, added validation checks since these are required fields.

## Build & Test Results

- Shell syntax validation: PASS (`bash -n launch.sh && bash -n setup.sh`)
- TypeScript typecheck: PASS (`npx tsc --noEmit`)
- Server tests: Not affected (changes are shell-script-only)

## Open Questions / Risks

None. All changes are minimal and targeted.

## Suggested Follow-ups

None.
