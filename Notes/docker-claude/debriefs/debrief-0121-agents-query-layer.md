# Debrief 0121 -- Agents Query Layer Rewrite

## Task Summary

Rewrite `server/src/queries/agents.ts` to align with the new schema that uses UUID v7 primary keys, composite unique constraint on `(projectId, name)`, and soft-delete semantics. Every function that takes an agent name now also requires `projectId`, hard-delete is removed in favor of soft-delete, and `getProjectId` is removed.

## Changes Made

- **server/src/queries/agents.ts** -- Full rewrite:
  - Added `import { v7 as uuidv7 } from 'uuid'`
  - `RegisterOpts`: made `projectId` required (no default), removed optional marker
  - `register`: generates UUID v7 for new rows, upsert targets composite `[projectId, name]`, omits `id` and `projectId` from conflict update set
  - `getByName`: added required `projectId` parameter, where-clause uses `and(eq(projectId), eq(name))`
  - `updateStatus`: added required `projectId` parameter
  - `softDelete`: added `projectId`, now sets `status = 'deleted'` (was `'stopping'`)
  - `stopAgent`: new function, sets `status = 'stopping'`
  - `deleteAllForProject`: replaces `deleteAll`, soft-deletes all non-deleted agents in a project
  - `getActiveNames`: requires `projectId`, filters out both `'stopping'` and `'deleted'`
  - `getWorktreeInfo`: added `projectId` parameter
  - `getByIdInProject`: new helper for UUID-based lookup scoped to project
  - `getByToken`: unchanged (no name parameter, no projectId needed)
  - `getAll`: unchanged (optional projectId for backward compat)
  - Deleted: `hardDelete`, `deleteAll`, `getProjectId`

## Design Decisions

- Followed the plan verbatim with no deviations.
- The `register` function generates a fresh UUID v7 on every call, but the `id` is omitted from the `onConflictDoUpdate` set clause, so existing rows keep their original UUID.

## Build & Test Results

- `npx tsc --noEmit 2>&1 | grep 'queries/agents.ts'` returns nothing -- no type errors in the file itself.
- Full build will have errors in other files that reference the changed signatures; this is expected and handled in later phases.

## Open Questions / Risks

- Callers of the old signatures (routes, other queries) will break until updated in subsequent phases.
- The `register` function does not return the generated/existing UUID; callers needing the agent ID will need a follow-up query or the function signature may need adjustment in a later phase.

## Suggested Follow-ups

- Update all route files that call these functions to pass `projectId`.
- Update tests for agents queries to use new signatures.
- Consider having `register` return the upserted row (including `id`) for callers that need the UUID.
