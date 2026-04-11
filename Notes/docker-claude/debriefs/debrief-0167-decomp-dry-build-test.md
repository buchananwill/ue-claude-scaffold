# Debrief 0167 -- DRY refactoring of build.test.ts

## Task Summary

Address two DRY violation warnings from decomposition review in `server/src/routes/build.test.ts`:
1. Repeated beforeEach/afterEach boilerplate across four describe blocks
2. Duplicated bare-repo + staging-worktree setup between "branch resolution" and "staging worktree sync" blocks

## Changes Made

- **File**: `server/src/routes/build.test.ts` (modified)
  - Extracted `createBuildTestContext(configOverrides, opts?)` -- shared factory that creates a Drizzle test app, registers plugins (optionally including agentsPlugin), and returns a unified cleanup function. Eliminates the identical afterEach bodies and duplicated `createDrizzleTestApp()` + `createTestConfig()` + plugin registration pattern.
  - Extracted `createGitTestInfrastructure(tmpDir, opts?)` -- creates bare repo, staging root, and project directory. Accepts optional `seedSetup` callback for custom seed content and `cloneAgent` option to clone a staging worktree for a named agent. Used by both "branch resolution" and "staging worktree sync" blocks.
  - All four describe blocks now use the shared helpers, with each afterEach reduced to a single `await teardown()` call.

## Design Decisions

- Kept both helpers local to the test file (no separate module) per the task constraints.
- Used a callback pattern (`seedSetup`) for the git infrastructure helper to accommodate the "staging worktree sync" block's custom seed content without making the helper overly complex.
- The `createBuildTestContext` cleanup function takes `tmpDir` as a parameter rather than capturing it, keeping the factory stateless and flexible.
- The `projectPath` created by `createGitTestInfrastructure` is only used by "branch resolution" -- the "staging worktree sync" block uses `agentStagingDir` as its project path instead.

## Build & Test Results

- Typecheck: PASS (`npm run typecheck`)
- Tests: PASS (all 17 tests across 5 describe blocks via `npx tsx --test src/routes/build.test.ts`)

## Open Questions / Risks

None. This is a pure refactoring with no behavioral changes.

## Suggested Follow-ups

None.
