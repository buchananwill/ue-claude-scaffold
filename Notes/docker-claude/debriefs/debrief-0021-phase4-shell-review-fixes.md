# Debrief 0021 -- Phase 4 Shell Script Review Fixes

## Task Summary

Apply 12 consolidated review findings for Phase 4 (shell scripts) covering style, safety, and correctness issues in `launch.sh` and `setup.sh`.

## Changes Made

- **launch.sh**: Changed `ERROR:` to `Error:` in collision guard message (fix 1).
- **launch.sh**: Changed `x-project-id` header to `X-Project-Id` (fix 2).
- **launch.sh**: Replaced `grep` with `jq` for collision guard status check (fix 7).
- **launch.sh**: Added collision guard for team member launches with `return 1` to skip rather than exit (fix 4).
- **launch.sh**: Added validation of `_MEMBER_NAME` and `_MEMBER_TYPE` against `^[a-zA-Z0-9_-]+$` (fix 5).
- **launch.sh**: Added `ROOT_BRANCH` override warning when it differs from the expected value (fix 8).
- **launch.sh**: Changed team member compose project name from `claude-${_MEMBER_NAME}` to `claude-${PROJECT_ID}-${_MEMBER_NAME}` at both `down` and `up` calls (fix 9).
- **launch.sh**: Added `HOOK_BUILD_INTERCEPT` to the team member `docker compose up` env block (fix 10).
- **setup.sh**: Renamed `pid` to `project_id` in `_create_bare_and_root` and `_init_bare_repo` functions (fix 3).
- **setup.sh**: Added validation of project keys from JSON in multi-project loop (fix 6).
- **setup.sh**: Added error handling to migration `git update-ref` call (fix 11).
- **setup.sh**: Added comment explaining "default" as the canonical sentinel for single-project/legacy mode (fix 12).

## Design Decisions

- For the team member collision guard (fix 4), used `grep -q '^active$'` piped from jq rather than a variable comparison, matching the plan's suggested pattern. This differs slightly from the single-agent guard (fix 7) which uses a variable, but both approaches are correct.
- The migration `update-ref` error handling (fix 11) uses `return` rather than `return 0` since the function is not under `set -e` constraints that would require masking the error.

## Build & Test Results

- Shell syntax validation: all 4 scripts pass (`bash -n`)
- TypeScript typecheck: passes (`npx tsc --noEmit`)
- All tests pass (0 failures)

## Open Questions / Risks

None.

## Suggested Follow-ups

None.
