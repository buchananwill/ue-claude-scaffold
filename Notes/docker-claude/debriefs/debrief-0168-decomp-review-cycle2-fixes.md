# Debrief 0168 -- Decomposition Review Cycle 2 Fixes

## Task Summary

Apply review findings from decomposition review cycle 2 to `server/src/routes/build.test.ts`. Six findings total: one BLOCKING (B1) and five WARNINGs (W1, W2, W3, Safety W1, Safety W2).

## Changes Made

- **File**: `server/src/routes/build.test.ts` (modified)
  - **[B1]** `createBuildTestContext` now accepts `tmpDir` as its first parameter and captures it in the closure. Cleanup signature changed from `async (tmpDir: string) => void` to `async () => void`. All four call sites updated to pass `tmpDir` and use `teardown = harness.cleanup` directly.
  - **[W1]** Renamed `createBuildTestSetup` to `createMockBuildFixture` to clearly differentiate from `createBuildTestContext`.
  - **[W2]** `createGitTestInfrastructure` now accepts optional `projectId` parameter (defaults to `'default'`), used in the branch name for `cloneAgent`.
  - **[W3]** Added `await ctx.app.ready()` before returning from `createBuildTestContext`.
  - **[Safety W1]** Replaced `execSync` template string for git clone with `execFileSync('git', [...args])` to avoid shell injection risk from unquoted `agentName`.
  - **[Safety W2]** Hoisted `agentStagingDir` to the describe-level scope in the staging worktree sync block. Removed the hand-reconstructed `path.join(tmpDir, 'staging', 'test-agent')` from the test body, reusing the value returned by `createGitTestInfrastructure`.

## Design Decisions

- Added `execFileSync` to the import from `node:child_process` since it was not previously imported.
- The `projectId` parameter on `createGitTestInfrastructure` is optional and defaults to `'default'`, so no existing call sites need changes.

## Build & Test Results

- Typecheck: PASS (`npm run typecheck`)
- Tests: 18/18 PASS (`npx tsx --test src/routes/build.test.ts`)

## Open Questions / Risks

None.

## Suggested Follow-ups

None.
