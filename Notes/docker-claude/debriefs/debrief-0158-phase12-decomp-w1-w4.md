# Debrief 0158 -- Phase 12 Decomp Review Fixes (W1, W4)

## Task Summary

Address decomposition review findings W1 and W4 from Phase 12. W1: extract shared build test setup helper in build.test.ts. W4: split tasks.test.ts second describe block into tasks-deps.test.ts.

## Changes Made

- **server/src/routes/build.test.ts** -- Extracted `createBuildTestSetup()` helper function that creates tmpDir, mock build script, and returns `baseBuildConfig`. All three describe blocks now call this helper in their `beforeEach` instead of duplicating the setup code. Removed per-block `mockScriptPath` variables where no longer needed.
- **server/src/routes/tasks.test.ts** -- Removed the second describe block (`tasks with bare repo and agents`, ~1738 lines) and its associated `initBareRepoWithBranch` helper. Removed now-unused imports (`execSync`, `path`, `mkdtempSync`, `rmSync`, `tmpdir`, `sql`). File reduced from 2638 to 894 lines.
- **server/src/routes/tasks-deps.test.ts** -- New file containing the extracted second describe block with its own imports (including `sql` from drizzle-orm and fs/path/child_process utilities). Fully self-contained.

## Design Decisions

- Kept `baseBuildConfig` as a plain object property rather than a full `ScaffoldConfig` partial, since each describe block composes it differently into `createTestConfig()`.
- The first describe block in tasks.test.ts no longer imports `sql`, `execSync`, `path`, `mkdtempSync`, `rmSync`, or `tmpdir` since those were only used by the second block.
- Named the new file `tasks-deps.test.ts` as suggested, consistent with existing sibling splits (`tasks-claim.test.ts`, `tasks-lifecycle.test.ts`, `tasks-replan.test.ts`).

## Build & Test Results

Pending initial build.

## Open Questions / Risks

None -- straightforward extraction with no behavioral changes.

## Suggested Follow-ups

- W2 and W3 from the decomposition review are out of scope for this phase and should be addressed separately.
