# Debrief 0044 -- Phase 1: Foundations -- Shared Bash Libraries

## Task Summary

Create the `scripts/lib/` directory with four reusable Bash library files that extract duplicated patterns from the top-level shell scripts (launch.sh, stop.sh, status.sh, setup.sh). These libraries will be consumed by refactored scripts in later phases.

## Changes Made

- **scripts/lib/validators.sh** -- Created. Exports `_validate_identifier` (alphanumeric+hyphen+underscore check) and `_validate_branch_name` (mirrors BRANCH_RE from server/src/branch-naming.ts). Includes double-source guards.
- **scripts/lib/compose-detect.sh** -- Created. Exports `_detect_compose` which sets `COMPOSE_CMD` to the available docker compose variant. Extracted from stop.sh:91-99 and launch.sh:309-318.
- **scripts/lib/curl-json.sh** -- Created. Exports `_post_json` (temp-file-based POST with automatic X-Project-Id/X-Agent-Name headers) and `_get_json` (simple GET). Uses mktemp for body to avoid shell quoting issues.
- **scripts/lib/colors.sh** -- Created. Exports color variables (C_RESET, C_BOLD, C_DIM, C_YELLOW, C_GREEN, C_RED) respecting NO_COLOR and TTY detection, plus `status_color()`. Extracted from status.sh:82-106.

## Design Decisions

- **Double-source guards**: Each file uses a `_LIB_*_LOADED` readonly variable to prevent re-sourcing, similar to C header guards.
- **`_` prefix convention**: All exported functions use underscore prefix per existing project convention for internal helpers.
- **`_validate_branch_name` decomposed checks**: Rather than trying to encode the full regex in a single bash `=~` (which would be fragile), the function uses sequential checks for each constraint. This is more readable and produces specific error messages.
- **`_post_json` cleanup**: Uses `rm -f` after the curl call rather than relying solely on `trap RETURN`, since `trap RETURN` is not universally supported in all bash versions. The trap is attempted but failure is tolerated.
- **No modifications to existing scripts**: Phase 1 only creates the libraries. Later phases will wire them into the top-level scripts.

## Build & Test Results

- `bash -n` syntax checks passed for all four files.
- No runtime tests needed for this phase (libraries are not yet sourced by any script).

## Open Questions / Risks

- The `_validate_branch_name` bash implementation mirrors the JS regex but uses sequential string checks. There is a small risk of divergence if the JS regex is updated without updating the bash version. A comment in validators.sh references the source file to aid maintenance.
- `trap RETURN` for temp file cleanup in `_post_json` may not work in all bash versions (< 4.0). The explicit `rm -f` after curl ensures cleanup regardless.

## Suggested Follow-ups

- Phase 2+: Replace duplicated validation/compose-detection/color blocks in launch.sh, stop.sh, status.sh, and setup.sh with `source` calls to these libraries.
- Consider adding a `scripts/lib/config.sh` for the duplicated scaffold.config.json reading pattern.
