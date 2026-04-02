# Debrief 0008 -- Phase 1 Review Cycle 4 Fixes

## Task Summary

Fix all findings from the Phase 1 review cycle 4: one blocking correctness issue (checkLock hardcoding 'default' project ID) and four style warnings (duplicate interface, startup log, PATCH validation gap, JSDoc).

## Changes Made

- **server/src/routes/build.ts**: Added `projectId: string` parameter to `checkLock()`, updated both call sites (`/build` and `/test` handlers) to pass the already-resolved `projectId`.
- **server/src/config.ts**: Removed duplicate `ProjectDbRow` interface. Imported `ProjectRow` from `queries/projects.js` and used it as the `dbRow` parameter type in `getProject()`.
- **server/src/index.ts**: Replaced single-project startup log with multi-project log when `resolvedProjects` has more than one entry; single-project log remains as fallback.
- **server/src/routes/projects.ts**: Added `engineVersion` validation to the PATCH handler, matching the POST handler's existing validation.
- **server/src/queries/projects.ts**: Added JSDoc on `update()` documenting null-return semantics and empty-set fallback behavior.

## Design Decisions

- For Fix 2, `ProjectRow` from `queries/projects.ts` is a structural superset of the removed `ProjectDbRow` (has an extra `createdAt` field). Since `getProject()` never accesses `createdAt`, this is a safe substitution.
- For Fix 4, used `Object.keys(config.resolvedProjects).length > 1` to distinguish multi-project mode from single-project (legacy) mode.

## Build & Test Results

- `npm run build` -- clean, no errors.
- `npx tsx --test src/queries/projects.test.ts src/routes/projects.test.ts src/routes/health.test.ts` -- 30 passed, 0 failed.

## Open Questions / Risks

None.

## Suggested Follow-ups

- Item 3 (planBranch -> seedBranch rename) is deferred to Phase 2 as noted in the instructions.
