# Debrief 0166 -- Phase 2: Rename regression test for syncWorktree

## Task Summary

Implement Phase 2 of the fix-staging-worktree-rename-ghost-files plan: add a regression test to `server/src/routes/build.test.ts` that verifies `syncWorktree` correctly removes the old file when git detects a rename (delete + add with overlapping content).

## Changes Made

- **File**: `server/src/routes/build.test.ts`
  - **Action**: modified
  - **What changed**: Added `existsSync` to the `node:fs` import. Added a new `describe('build route staging worktree sync', ...)` block with a single test `it('removes the old file when git detects a rename', ...)`. The test sets up a bare repo, seed clone, and staging worktree with an initial file containing 60+ lines of content. After a first `/build` request establishes `refs/scaffold/last-sync`, it commits a rename (delete old file, add new file with ~50 shared lines to trigger git's rename detector), pushes, issues a second `/build`, then asserts the old file is gone and the new file exists via `fs.existsSync`.

## Design Decisions

- Used helper functions (`sharedContent`, `oldFileContent`, `newFileContent`) to generate file content with 50 shared lines plus 10 unique lines per file. This exceeds git's default rename detection threshold (typically ~50% similarity).
- The test clones from the bare repo into the staging directory (rather than using `git init`) to ensure the staging worktree starts in a coherent state with proper remote tracking, matching how the real system operates.
- The mock build script simply exits 0 since this test is about sync behavior, not build invocation.

## Build & Test Results

- `npm run typecheck` -- exits 0, no type errors.
- `npx tsx --test src/routes/build.test.ts` -- all 5 suites pass (17 tests total), including the new rename regression test which completed in ~2.5s.

## Open Questions / Risks

- None. The test validates the Phase 1 `--no-renames` fix is working correctly.

## Suggested Follow-ups

- Phase 3 (unstick the live piste-perfect/agent-2 staging worktree) is an operator-executed action.
- Phase 4 (close issue 047) is a cleanup task.
