# Debrief 0029: Decomposition Review Findings

## Task Summary

Fix 11 review findings (7 blocking, 4 warning) discovered after the DRY refactoring / decomposition phase. These span validation regressions, status code mismatches, module placement issues, and style violations.

## Changes Made

- **server/src/branch-naming.ts** -- Exported `BRANCH_RE` (was `const`, now `export const`).
- **server/src/routes/projects.ts** -- Replaced weak local regex with imported `BRANCH_RE` for seedBranch validation. Imported `isValidProjectId` from `branch-naming.js` directly instead of via `projectsQ`.
- **server/src/git-utils.ts** -- Replaced `catch (err: any)` with `catch (err)` + instanceof check in two places. Added `isValidAgentName` guard inside `mergeIntoAgentBranches` loop.
- **server/src/tasks-validation.ts** (moved from routes/) -- Extended return type to include `synced: boolean` and `code: 400 | 422` fields. Added `log.warn` when `syncExteriorToBareRepo` fails. Fixed imports for new location.
- **server/src/resolve-project.ts** (moved from routes/) -- Fixed imports for new location.
- **server/src/routes/tasks.ts** -- Updated all three `validateSourcePath` call sites to use `code` field for correct HTTP status (400 vs 422). Fixed `batchSynced` to only set true when `spCheck.synced` is true. Removed duplicate inline path-traversal checks (now handled by `validateSourcePath`).
- **server/src/routes/tasks-files.ts** -- Updated `resolveProject` import path.
- **server/src/routes/agents.ts** -- Updated `resolveProject` import path.
- **server/src/routes/build.ts** -- Updated `resolveProject` import path.
- **server/src/routes/sync.ts** -- Updated `resolveProject` import path.
- **server/src/routes/tasks-lifecycle.ts** -- Updated `resolveProject` import path.
- **server/src/routes/tasks-claim.ts** -- Updated `resolveProject` import path.
- **server/src/queries/projects.ts** -- Removed `isValidProjectId` re-export; added direct import from `branch-naming.js` for internal use in `seedFromConfig`.
- **server/src/queries/projects.test.ts** -- Updated to import `isValidProjectId` directly from `branch-naming.js`.
- **launch.sh** -- Added `PROJECT_ID` length check (max 64 characters).

## Design Decisions

- **validateSourcePath return type**: Added `synced` and `code` fields to the return type rather than creating separate error subtypes. This keeps the API simple while giving callers the information they need.
- **HTTP status code mapping**: "Unknown project" errors use 400 (bad request -- client sent an invalid project ID), while "sourcePath not found" errors use 422 (unprocessable -- the entity references a path that doesn't exist). Path traversal errors also use 400.
- **Module placement**: `resolve-project.ts` and `tasks-validation.ts` moved to `src/` since they are shared utilities used by multiple route files, not route plugins themselves.

## Build & Test Results

- **Build**: SUCCESS (`npx tsc --noEmit` -- clean, no errors)
- **Tests**: 48 suites passed, 0 failed, 0 skipped
- **Shell validation**: `bash -n launch.sh` -- clean

## Open Questions / Risks

- Fix #7 (sync.ts wildcard validation) was noted as not needing a code change since fix #6 adds internal validation in `mergeIntoAgentBranches`. This is correct -- the wildcard case resolves names from the DB which are already validated on insert.

## Suggested Follow-ups

- None; all 11 findings are addressed.
