# Debrief 0010 -- Branch-Naming Review Fixes

## Task Summary

Fix all review findings (style, safety, correctness) for the Phase 2 branch-naming helper module in `server/src/branch-naming.ts` and its test file.

## Changes Made

- **server/src/branch-naming.ts** -- Imported `ProjectRow` type and changed `seedBranchFor` parameter from hand-rolled structural type to `Pick<ProjectRow, 'seedBranch'>`. Added input validation regex guards (`PROJECT_ID_RE`, `AGENT_NAME_RE`, `BRANCH_RE`, `PATH_TRAVERSAL_RE`) to both exported functions. Added JSDoc to `seedBranchFor` documenting empty-string fallback behavior.
- **server/src/branch-naming.test.ts** -- Added `beforeEach, afterEach` to `node:test` import per project convention. Added test cases for malicious/path-traversal inputs: `../evil` projectId, `../other` agentName, `refs/../../../config` seedBranch. Added tests for empty string inputs.

## Design Decisions

- The `BRANCH_RE` regex from the safety review allows `.` characters, which means `..` path traversal sequences pass the allowlist. Added a separate `PATH_TRAVERSAL_RE` check specifically for `..` sequences to catch this.
- Used `as unknown as string | null` cast in the `undefined` seedBranch test since `Pick<ProjectRow, 'seedBranch'>` makes `seedBranch` required (not optional), but we still want to test runtime behavior with `undefined`.

## Build & Test Results

- TypeScript typecheck: PASS (`npx tsc --noEmit`)
- Tests: 14 passed, 0 failed (`npx tsx --test src/branch-naming.test.ts`)

## Open Questions / Risks

- None identified.

## Suggested Follow-ups

- None.
