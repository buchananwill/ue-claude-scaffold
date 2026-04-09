# Debrief 0137 -- Phase 8 Review Findings Fixes

## Task Summary

Fix consolidated review findings from style, safety, and correctness reviewers on the Phase 8 agents routes work. Ten findings total (3 blocking, 7 warnings), plus one out-of-scope item that just needed a code comment.

## Changes Made

- **server/src/queries/agents.ts**
  - Added `AgentPublicRow` type (`Omit<AgentRow, 'sessionToken'>`) for safe external use.
  - Added `publicColumns` selection object to avoid leaking `sessionToken` in queries.
  - Updated `getAll`, `getByName`, `getByIdInProject` to return `AgentPublicRow` via column projection.
  - Added `getByNameFull` for internal use where `sessionToken` is needed (DELETE with token check).
  - Changed `softDelete`, `deleteAllForProject`, `updateStatus`, `stopAgent` to accept `DbOrTx` instead of `DrizzleDb`, enabling use inside transactions without `as any` casts.
  - Replaced silent `?? ''` fallback in `register` with an assertion error.
  - Added JSDoc comment on `VALID_STATUSES` for clarity.

- **server/src/queries/tasks-lifecycle.ts**
  - Imported `DbOrTx` from drizzle-instance.
  - Changed `releaseByAgent` and `releaseAllActive` to accept `DbOrTx` instead of `DrizzleDb`.

- **server/src/routes/agents.ts**
  - Renamed route-layer `AgentRow` to `AgentResponse` to avoid name collision with query-layer type.
  - Updated `formatAgent` to accept `AgentPublicRow` (imported from queries) and return `AgentResponse`.
  - Removed `?project=` query parameter from `GET /agents` -- always uses `request.projectId` from header.
  - Removed all six `tx as any` casts in transaction bodies (now type-safe with `DbOrTx`).
  - Removed extra `message` field from deleted-status 400 response to match general invalid-status shape.
  - Added `ALLOWED_STATUSES` comment explaining intentional exclusion of `'deleted'`.
  - Added code comments on DELETE endpoints documenting intentional sessionToken-optional design.
  - Used `getByNameFull` in DELETE handler where `sessionToken` field is needed.

- **server/src/routes/agents.test.ts**
  - Added cross-project isolation test: agent registered under `proj-a` returns 404 when queried with `proj-b`.
  - Added bulk DELETE idempotency test: second call returns `{ ok: true, deletedCount: 0 }`.
  - Added `projects` import for seeding test project rows.

## Design Decisions

- Introduced `getByNameFull` rather than making all queries return the full row. Only the DELETE handler needs `sessionToken` for verification, so keeping the default path safe (`AgentPublicRow`) is worthwhile.
- Changed `updateStatus` and `stopAgent` to `DbOrTx` as well since `softDelete` delegates to `updateStatus` -- both need the same parameter type in the call chain.
- Used `.returning()` without column selection in `register` because the Drizzle union type (`DrizzleDb`) does not support partial returning with `onConflictDoUpdate`.

## Build & Test Results

- **Build**: SUCCESS (all errors in my files resolved; remaining errors are in other-phase files: rooms.ts, tasks-claim.ts, files.ts, etc.)
- **Tests**: 22 passed, 4 failed. All 4 failures are pre-existing sync suite failures caused by missing global git identity in the Docker container (not related to my changes). All 19 main suite tests + 3 task release tests pass, including the 2 new tests.

## Open Questions / Risks

- The `queries/agents.test.ts` file (a separate file from `routes/agents.test.ts`) has many pre-existing errors referencing functions that don't exist (`deleteAll`, `hardDelete`, `getProjectId`). These appear to be from a different phase's work-in-progress.
- The sync test failures in `routes/agents.test.ts` are pre-existing (git identity not configured globally in the Docker container).

## Suggested Follow-ups

- Fix `queries/agents.test.ts` to match the current query API signatures.
- Configure global git identity in Docker containers so sync tests pass.
- Consider whether `getByNameFull` should require a justification parameter or audit trail to prevent casual use.
