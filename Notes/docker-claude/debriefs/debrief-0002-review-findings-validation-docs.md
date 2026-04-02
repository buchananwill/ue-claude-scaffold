# Debrief 0002 — Review Findings: Docs, Validation, Basename Safety

## Task Summary

Fix all review findings from cycle 1 (Issue #038, Phase 1). Seven discrete fixes across README.md, launch.sh, and server/src/config.ts.

## Changes Made

- **README.md**: Removed `tasks.path` from Quick Start required fields comment (line 65).
- **README.md**: Removed `tasks.path` row from config field table.
- **README.md**: Fixed `server.stagingWorktreePath` to `server.stagingWorktreeRoot` in field table.
- **launch.sh**: Added character-class validation for `--team` value (`^[a-zA-Z0-9_-]+$`).
- **launch.sh**: Added path traversal validation for `--brief` value (rejects absolute paths and `..` components).
- **launch.sh**: Replaced `xargs basename` with safe `basename "$var"` pattern in both multi-project and legacy config branches (4 lines total).
- **server/src/config.ts**: Sanitised project ID in `getProject()` error message — truncates to 64 chars and replaces non-alphanumeric characters.

## Design Decisions

- For the `xargs basename` replacement, preserved the exact same jq expressions. Only changed the piping pattern to capture into a variable first, then call `basename` with proper quoting.
- The `--team` and `--brief` validations are placed immediately after the argument is parsed (inside the case block), matching the task instructions.

## Build & Test Results

- Shell syntax validation: PASS (`bash -n` on all four scripts)
- Server TypeScript build: PASS
- Server tests: 398 pass, 55 fail (2 test suites). Failures are pre-existing git-config issues in the Docker environment (bare repo tests requiring `user.name`/`user.email`), unrelated to these changes.

## Open Questions / Risks

- None. All changes are direct fixes from reviewer instructions.

## Suggested Follow-ups

- Fix the git config in the Docker container test environment so bare-repo-dependent tests pass.
