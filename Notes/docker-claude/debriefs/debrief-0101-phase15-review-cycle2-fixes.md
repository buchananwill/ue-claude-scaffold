# Debrief 0101 - Phase 15 Review Cycle 2 Fixes

## Task Summary

Fix all BLOCKING and WARNING issues from Phase 15 (Decompose status.sh) Cycle 2 review. Six blocking items (B1-B6) and six warnings (W1-W6).

## Changes Made

- **server/src/routes/status.ts**: Removed `as unknown as` casts for AgentRow and MessageRow (B1 -- kept TaskRow cast due to snake_case/camelCase structural mismatch, matching codebase pattern). Removed `project` query param, use `request.projectId` exclusively (B3). Added `since` validation returning 400 for non-integer/negative values (B5). Clamped taskLimit to [1, 200] (B4). Added MESSAGE_LIMIT=200 to cap message results (B5). Plugin typing already correct as bare `FastifyPluginAsync` matching searchPlugin/messagesPlugin convention (B2).

- **server/src/routes/status.test.ts**: Switched `before`/`after` to `beforeEach`/`afterEach` for test isolation (W1). Added `since=0` test case (W5). Added invalid/negative `since` 400 tests. Added taskLimit upper bound test. Replaced `project` query param test with X-Project-Id header test (B3).

- **status.sh**: Replaced all `echo -e` with `printf '%b\n'` for portability (W2). Removed `local summary` from piped subshell (W3). Fixed task status column width from `%-20b` to `%-12b` matching headers (B6). Introduced `_SHOW_PROJECT` variable to replace `PROJECT_ID` checks in display functions (W4). Removed `project=` query param from URL construction, relying solely on X-Project-Id header (B3). Added terminal escape safety comment (W6).

## Design Decisions

- Kept `as unknown as TaskRow` cast because TaskRow interface has required snake_case fields (project_id, source_path, etc.) that Drizzle's camelCase output doesn't match. This is a codebase-wide pattern (tasks.ts, tasks-claim.ts all do the same). AgentRow and MessageRow use camelCase matching Drizzle output, so those casts were successfully removed.
- Used `messageRows.slice(0, MESSAGE_LIMIT)` as a safety belt since the `msgQ.list` polling mode ignores the `limit` parameter.
- `since=0` treated same as no-since by converting 0 to undefined via `parsed || undefined`.

## Build & Test Results

- Build: SUCCESS (`npm run build` clean)
- Tests: 10 passed, 0 failed (`npx tsx --test src/routes/status.test.ts`)
- Shell syntax: PASS (`bash -n status.sh`)

## Open Questions / Risks

- The TaskRow snake_case/camelCase dual interface is a broader codebase concern. The `as unknown as TaskRow` pattern is used in 5+ route files. A proper fix would be to align the interface with Drizzle output.

## Suggested Follow-ups

- Refactor TaskRow to use camelCase-only fields matching Drizzle output, eliminating all `as unknown as TaskRow` casts across the codebase.
