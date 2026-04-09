# Debrief 0149 — Phase 10 Decomp: Agent Resolution Helper, Merge Conflict Queries, Simplify TaskRow

## Task Summary

Fix three WARNING findings from the decomposition review:
1. W1: Extract shared agent name-to-UUID resolution helper to reduce duplication across 8+ call sites.
2. W2: Merge `getFileConflicts` and `getFileConflictsForTask` into a single function with optional exclusion parameter.
3. W3: Remove snake_case fields from `TaskRow`, eliminate `pick()` helper, have `formatTask` read camelCase fields directly.

## Changes Made

- **server/src/routes/route-helpers.ts** (created): New shared `resolveAgentId(db, projectId, name)` helper that wraps `agentsQ.getByName`.
- **server/src/routes/tasks-claim.ts** (modified): Two call sites switched from `agentsQ.getByName` to `resolveAgentId`.
- **server/src/routes/rooms.ts** (modified): Six call sites switched from `agentsQ.getByName` to `resolveAgentId`. Removed unused `agentsQ` import.
- **server/src/routes/tasks-lifecycle.ts** (modified): One call site switched from `agentsQ.getByName` to `resolveAgentId`. Removed unused `agentsQ` and `TaskRow` imports.
- **server/src/routes/teams.ts** (modified): One call site switched from `agentsQ.getByName` to `resolveAgentId`. Removed unused `agentsQ` import.
- **server/src/routes/files.ts** (modified): One call site switched from `agentsQ.getByName` to `resolveAgentId`. Removed unused `agentsQ` import.
- **server/src/queries/task-files.ts** (modified): Merged `getFileConflicts` and `getFileConflictsForTask` into a single `getFileConflicts(db, taskId, excludeAgentId?)` function.
- **server/src/queries/task-files.test.ts** (modified): Updated test to call merged function without exclusion parameter.
- **server/src/routes/tasks-types.ts** (modified): Removed all snake_case fields from `TaskRow`, removed `pick()` helper, `formatTask` reads camelCase fields directly.
- **server/src/routes/status.ts** (modified): Replaced `formatTask(r as unknown as TaskRow)` with `formatTask(toTaskRow(r))` to properly convert Drizzle rows.
- **server/src/routes/tasks-files.ts** (modified): Updated `getFileConflictsForTask` call to `getFileConflicts` (no exclusion), removed snake_case fallbacks in `blockReasonsForTask`, added non-null assertion for conflict claimant.

## Design Decisions

- The `resolveAgentId` helper returns `AgentPublicRow | null` rather than throwing, keeping the 404 handling at the call site. This preserves the existing pattern where different call sites return different HTTP status codes (404, 403, 400) on resolution failure.
- For W2, the merged function uses `string | null` for the `claimant` return type since without `excludeAgentId` the claimant could theoretically be null (though the IS NOT NULL filter prevents it). A non-null assertion is used at the one call site that needs `string`.
- For W3, `status.ts` now uses `toTaskRow(r)` instead of `r as unknown as TaskRow` to properly map `claimedByAgentId` to `claimedBy`.

## Build & Test Results

- Typecheck passes with zero non-test-file errors. Pre-existing test file errors are unchanged.

## Open Questions / Risks

- None identified.

## Suggested Follow-ups

- The `resolveAgentId` helper could be enhanced to throw a typed error that a Fastify error handler catches, further reducing the null-check boilerplate at each call site.
