# Debrief 0129 -- Phase 6: Decomposition DRY helpers and shared DbOrTx type

## Task Summary

Fix four decomposition review findings across the query layer: extract DRY helpers for structurally identical functions, eliminate duplicate file-release logic, and define a shared `DbOrTx` type to remove `as any` casts.

## Changes Made

- **server/src/drizzle-instance.ts** -- Added `DbOrTx` type alias (`DrizzleDb | DrizzleTx`) as a shared export, alongside the existing `DrizzleDb` and `DrizzleTx` types.

- **server/src/queries/tasks-lifecycle.ts** -- Extracted private `finalize()` helper for `complete()` and `fail()`, which were structurally identical except for the status string. Extracted private `integrateWhere()` helper for `integrateBatch()` and `integrateAll()`, which differed only in an optional agent-ID where-clause condition. Both public functions now delegate to the shared helpers. Added `SQL` type import from drizzle-orm for the `extraConditions` parameter.

- **server/src/queries/files.ts** -- Changed import from `DrizzleDb` to `DbOrTx` and updated all three exported functions (`list`, `releaseByClaimantAgentId`, `releaseAll`) to accept `DbOrTx`, allowing them to be called from transaction contexts without casts.

- **server/src/queries/coalesce.ts** -- Removed local `DbOrTx` type definition, now imports `DbOrTx` from `drizzle-instance.js`. Changed `releaseAllFiles()` to delegate to `files.releaseAll()` instead of duplicating the same query.

- **server/src/queries/ubt.ts** -- Changed all function parameter types from `DrizzleDb` to `DbOrTx`, enabling transactional use without casts.

- **server/src/routes/ubt.ts** -- Removed all `as any` casts on `tx` arguments in `clearLockAndPromote()` and the `/ubt/acquire` handler, now that the query functions accept `DbOrTx`.

## Design Decisions

- The `integrateWhere` helper uses `SQL[]` for extra conditions rather than a more specific type, since `eq()` returns `SQL<unknown>` which is assignable to `SQL`. An empty array for `integrateAll` works cleanly with the spread into `and()`.
- All functions in `files.ts` were widened to `DbOrTx` (not just `releaseAll`) since they may reasonably be called from transactions in future.
- The `DrizzleTx` import was removed from `coalesce.ts` since it now imports `DbOrTx` directly.

## Build & Test Results

- Typecheck passes with no errors in any changed files. Pre-existing errors in unrelated files remain unchanged.
- UBT route tests (16 tests) fail identically with and without these changes -- confirmed pre-existing failures unrelated to this work (likely schema/migration mismatch in tests).

## Open Questions / Risks

- The UBT test suite has 16 pre-existing failures (all returning 500). These appear to be a test infrastructure issue, not caused by these changes.

## Suggested Follow-ups

- Investigate and fix the 16 pre-existing UBT test failures.
- Consider widening other query files to `DbOrTx` as needed.
