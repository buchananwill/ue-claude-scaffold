# Debrief 0175 -- Agent Type Override DRY Fixes

## Task Summary

Fix two decomposition review warnings in the Phase 2 agent_type_override work:
- W1: Extract duplicated agentTypeOverride validation into a shared pure function
- W2: Remove redundant `?? undefined` and `?? null` coalescing operators

## Changes Made

- **server/src/routes/tasks-files.ts** -- Added `validateAgentTypeOverride(value, mode)` function and imported `isValidAgentName` from `branch-naming.ts`. The function validates in two modes: `create` (rejects null) and `patch` (allows null for clearing). Error messages are defined once inside this function.

- **server/src/routes/tasks.ts** -- Replaced 3 duplicated validation blocks (POST /tasks single, POST /tasks/batch loop, PATCH /tasks/:id) with calls to `validateAgentTypeOverride`. Added import for the new function. Removed unused `isValidAgentName` import. Removed `?? undefined` coalescing on two `agentTypeOverride` assignments (single create and batch insert).

- **server/src/queries/tasks-core.ts** -- Replaced inline validation logic in `patch()` with a call to `validateAgentTypeOverride`. Changed import from `isValidAgentName` (branch-naming) to `validateAgentTypeOverride` (tasks-files).

- **server/src/routes/tasks-types.ts** -- Removed redundant `?? null` on `row.agentTypeOverride` in `toTaskRow()` since the column is already nullable.

## Design Decisions

- The `validateAgentTypeOverride` function lives in `tasks-files.ts` as specified by the plan, alongside other task body helpers. This creates a circular import with `tasks-core.ts` (tasks-files -> tasks-core -> tasks-files), but ESM handles this correctly since the import is only used inside a function body, not at module evaluation time.
- The function returns `{ valid: true, value: string | null }` on success and `{ valid: false, error: string }` on failure, matching the plan's specified signature.
- For the batch route, the error message is prefixed with `Task ${i}:` at the call site, keeping the validator free of call-site-specific context.

## Build & Test Results

- Build: SUCCESS (`npm run build` and `npm run typecheck` both clean)
- Tests: 61/61 pass in `tasks.test.ts`, 17/17 pass in `tasks-core.test.ts`
- All 11 existing agentTypeOverride tests pass without modification

## Open Questions / Risks

- The circular import (tasks-files <-> tasks-core) is safe for ESM but could be fragile if someone adds a module-level usage. A future refactor could move the pure validator to a separate utility file.

## Suggested Follow-ups

- None required; all validation is now centralized and tested.
