# Debrief 0083 -- Phase 11 Review Cycle 2 Fixes

## Task Summary

Fix all review findings from Phase 11 cycle 2, covering type safety, input validation, PK conflict handling, transaction wrapping, and new tests.

## Changes Made

- **server/src/drizzle-instance.ts** -- Exported `DrizzleTx` type (union of PGlite and node-postgres transaction client types) alongside existing `DrizzleDb`.
- **server/src/queries/teams.ts** -- Imported `DrizzleTx`, defined `DbOrTx = DrizzleDb | DrizzleTx`, changed all function `db` params from `DrizzleDb` to `DbOrTx`.
- **server/src/queries/rooms.ts** -- Same `DbOrTx` pattern applied to all query functions.
- **server/src/queries/chat.ts** -- Same `DbOrTx` pattern applied to all query functions.
- **server/src/routes/teams.ts** -- Removed all `tx as any` casts (now type-safe via `DbOrTx`). Added `TEAM_ID_RE` validation on `id` field. Imported `AGENT_NAME_RE` and validated each member's `agentName`. Added non-empty `role` validation.
- **server/src/team-launcher.ts** -- Imported `roomsQ`. Wrapped DB writes (check existing, delete stale, createWithRoom, sendMessage) in `db.transaction()`. Added cleanup of dissolved team/room data before re-registration.
- **server/src/routes/teams.test.ts** -- Fixed `briefPath` from `/plans/brief.md` to `plans/brief.md` (input and assertion). Added POST /teams/:id/launch tests (missing briefPath, path traversal, absolute path, route registration). Added POST /teams input validation tests (invalid team id, invalid agentName, empty role).
- **scripts/launch-team.sh** -- Added `_NAME` format validation regex check after jq extraction.

## Design Decisions

- Used a `DbOrTx` type alias pattern local to each query module rather than exporting it globally, keeping the change scoped.
- Extracted `DrizzleTx` using TypeScript's `Parameters` utility on the `.transaction()` callback, avoiding dependency on Drizzle internal class names.
- The launch route happy-path test asserts 400 or 404 (project resolution or team def not found) since full integration requires filesystem/git setup.

## Build & Test Results

- Server build: SUCCESS (`npm run build`)
- Teams tests: 23 passed, 0 failed
- Shell syntax validation: all scripts pass `bash -n`

## Open Questions / Risks

- Other files (ubt.ts, agents.ts, coalesce.ts, tasks-replan.ts) still use `tx as any` casts. The `DbOrTx` pattern could be extended to their query modules in a follow-up.

## Suggested Follow-ups

- Apply the `DbOrTx` pattern to remaining query modules that are used in transactions (ubt, agents, files, coalesce, tasks-lifecycle, tasks-replan).
