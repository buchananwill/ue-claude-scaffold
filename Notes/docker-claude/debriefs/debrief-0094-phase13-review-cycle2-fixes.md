# Debrief 0094 -- Phase 13 Review Cycle 2 Fixes

## Task Summary
Fix all review findings from Phase 13 cycle 2, covering style, safety, and correctness issues across stop.sh, launch.sh, compose-detect.sh, and parse-launch-args.sh.

## Changes Made
- **stop.sh**: Removed `local` keywords at global scope (lines 184-185) -- plain assignments since they are not in a function.
- **stop.sh**: Added validation for AGENT_NAME and TEAM_ID using inline regex `^[a-zA-Z0-9_-]{1,64}$` after CLI parsing.
- **stop.sh**: Added validation for --timeout ensuring it is a positive integer.
- **stop.sh**: Removed dead `compose_file` variable in `stop_all()`.
- **stop.sh**: Hoisted `local agent_name` before for-loops in `stop_all()`, using plain assignment inside loops.
- **stop.sh**: Replaced `for member in $MEMBERS` with `mapfile -t _members` pattern for safe iteration.
- **launch.sh**: Guarded `_compile_agents` and agent collision check with `[[ "$_CLI_NO_AGENT" != "true" ]]` so --no-agent actually skips those steps.
- **scripts/lib/compose-detect.sh**: Changed em-dash to double-dash in header comment.
- **scripts/lib/parse-launch-args.sh**: Extended --brief validation to block hidden directories mid-path (`*/.* `).

## Design Decisions
- Used inline regex for AGENT_NAME/TEAM_ID validation in stop.sh rather than sourcing validators.sh, keeping stop.sh self-contained and consistent with its existing PROJECT_ID validation pattern.
- Added empty-members guard after mapfile to handle edge case of team with no members.

## Build & Test Results
All shell scripts pass `bash -n` syntax validation.

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
