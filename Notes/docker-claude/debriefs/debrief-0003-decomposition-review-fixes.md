# Debrief 0003 -- Decomposition Review Fixes (Issue #038)

## Task Summary

Fix 4 warnings raised by the decomposition reviewer:
1. W1: Remove dead `tasks.path` field from config
2. W2: Extract branch setup helper in `launch.sh`
3. W3: Extract bare repo creation helper in `setup.sh`
4. W4: Extract validation from `loadConfig()` in `server/src/config.ts`

## Changes Made

- **server/src/config.ts**: Removed `path` from `tasks` interface. Removed `path` parsing from `loadConfig()`. Extracted validation logic into exported `validateConfig(config, hasExplicitProjects)` function.
- **server/src/config.test.ts**: Updated test fixture at line 148 to omit `tasks.path`.
- **server/src/routes/tasks.test.ts**: Updated test fixture at line 518 to omit `tasks.path`.
- **server/src/routes/agents.test.ts**: Updated test fixture at line 262 to omit `tasks.path`.
- **scaffold.config.example.json**: Removed `"path": ""` from the `tasks` object.
- **launch.sh**: Extracted `_setup_branch()` helper function. Replaced duplicated branch setup logic in single-agent path (lines 612-624) and parallel-agent loop (lines 709-719) with calls to the helper.
- **setup.sh**: Extracted `_create_bare_and_root()` helper function containing the clone + resolve-HEAD + update-ref sequence. Replaced duplicated logic in both the non-interactive and interactive paths of `_init_bare_repo()` with calls to the helper.

## Design Decisions

- `validateConfig` is exported so it can be tested independently if desired.
- `_setup_branch` uses `local` for the `root_sha` variable to avoid polluting the outer scope.
- `_create_bare_and_root` preserves the `return 0` pattern (rather than returning non-zero) to maintain compatibility with `set -e` -- the original code intentionally returns 0 on failure to allow processing of remaining projects.

## Build & Test Results

- Shell syntax validation: PASS (all 4 scripts)
- `npm run build`: PASS (clean tsc compilation)
- `npm test`: 398 pass / 55 fail -- same failure count as the unmodified codebase. All 55 failures are pre-existing (git author identity not configured in container environment for bare repo test operations). Zero regressions from these changes.

## Open Questions / Risks

- The 55 pre-existing test failures are caused by missing git user config in the container environment (needed for tests that create commits in temporary bare repos). This is unrelated to the current changes.

## Suggested Follow-ups

- Fix the pre-existing test failures by ensuring git user identity is configured in the test environment or test helper.
- Consider adding dedicated unit tests for `validateConfig()` now that it is an exported function.
