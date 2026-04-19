# Debrief 0176 -- Move validateAgentTypeOverride to break circular dependency

## Task Summary

Fix a BLOCKING circular dependency between `queries/tasks-core.ts` and `routes/tasks-files.ts`, and add a missing self-defending guard to the `insert()` function in `tasks-core.ts`.

## Changes Made

- **server/src/branch-naming.ts** -- Added `validateAgentTypeOverride` function (moved from `routes/tasks-files.ts`). This is the canonical location since its only dependency (`isValidAgentName`) already lives here and `branch-naming.ts` has no imports from any tasks module.
- **server/src/routes/tasks-files.ts** -- Removed the `validateAgentTypeOverride` function definition and replaced it with a re-export from `../branch-naming.js`. Removed `isValidAgentName` from the `branch-naming` import (it was only used by the moved function) and added `validateAgentTypeOverride` to the import instead.
- **server/src/queries/tasks-core.ts** -- Changed import of `validateAgentTypeOverride` from `../routes/tasks-files.js` to `../branch-naming.js`, breaking the circular dependency. Added a self-defending validation guard to the `insert()` function, matching the pattern already in `patch()`.
- **server/src/routes/tasks.ts** -- Changed import of `validateAgentTypeOverride` from `./tasks-files.js` to `../branch-naming.js` for direct dependency clarity.

## Design Decisions

- Kept a re-export in `tasks-files.ts` (`export { validateAgentTypeOverride } from '../branch-naming.js'`) so that any downstream consumers importing from `tasks-files.ts` continue to work without breakage. The re-export does not create a circular dependency since `tasks-files.ts` re-exports from `branch-naming.ts`, not from `tasks-core.ts`.
- Updated `tasks.ts` to import directly from `branch-naming.js` rather than relying on the re-export, making the dependency graph explicit.

## Build & Test Results

- Build: SUCCESS (`npm run build` -- clean, no errors)
- Tests: 
  - `branch-naming.test.ts`: 29/29 passed
  - `queries/tasks-core.test.ts`: 17/17 passed
  - `routes/tasks.test.ts`: 61/61 passed (all 56 tests including 6 in a nested suite)

## Open Questions / Risks

None. The change is straightforward and all relevant tests pass.

## Suggested Follow-ups

None.
