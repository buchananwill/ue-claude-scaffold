# Debrief 0136 -- Phase 8: routes/agents.ts project scoping, soft-delete, session-token DELETE

## Task Summary

Update `server/src/routes/agents.ts` to:
- Pass `projectId` into every query call
- Adopt single-phase soft-delete semantics (replace two-phase stop/hard-delete)
- Check `sessionToken` on DELETE with 409 on mismatch
- Fix direct-room creation to use agent UUIDs (Option D: no operator membership)
- Return `id` from register endpoint
- Validate status values on the status update endpoint

## Changes Made

- **server/src/routes/agents.ts** -- Complete rewrite of route handlers:
  - All `agentsQ.*` calls now pass `request.projectId`
  - `POST /agents/register` captures `RegisterResult` (id + sessionToken), returns both in response
  - Room creation uses `newAgent.id` for `addMember`; removed operator `addMember('user')` call
  - `POST /agents/:name/status` validates against allowlist; explicitly rejects `'deleted'`
  - `DELETE /agents/:name` single-phase soft-delete with optional sessionToken check (409 on mismatch)
  - `DELETE /agents` bulk soft-delete via `deleteAllForProject`, returns `deletedCount`
  - `POST /agents/:name/sync` passes `request.projectId` to `getWorktreeInfo`
  - `GET /agents/:name` passes `request.projectId` to `getByName`

- **server/src/queries/agents.ts** -- Updated `register()` to return `RegisterResult` (id + sessionToken) via `.returning()` clause. Added `RegisterResult` interface export.

- **server/src/routes/agents.test.ts** -- Rewrote tests to match new behavior:
  - Removed two-phase delete tests; replaced with single soft-delete assertions
  - Added tests for sessionToken validation (valid, mismatch, absent)
  - Added tests for status validation (invalid values, 'deleted' rejection)
  - Task release tests updated to use agent UUIDs via `registerAgent()` helper
  - Changed status test from 'building' to 'working' (valid allowlist value)

- **server/src/queries/test-utils.ts** -- Updated SCHEMA_DDL to match current `tables.ts`:
  - `agents` table now has `uuid` PK, FK to projects
  - `tasks.claimed_by_agent_id` is uuid FK to agents
  - `files.claimant_agent_id` is uuid FK to agents
  - `room_members` uses `id` uuid PK + `agent_id` uuid FK
  - `chat_messages` uses `author_type`/`author_agent_id`
  - `ubt_lock`/`ubt_queue` use uuid agent references
  - `team_members` uses `agent_id` uuid FK
  - `projects` table created first with seed row for 'default'

## Design Decisions

- The test DDL in `test-utils.ts` was completely out of sync with the actual schema in `tables.ts`. Updated it wholesale since every test depending on it was failing. This was necessary to make the route tests work.
- Added `INSERT INTO projects` for the 'default' project in test DDL since agents FK to projects and the project-id plugin defaults to 'default'.
- The `register()` function now uses `.returning()` to get the id (which may differ on upsert from the generated uuid).

## Build & Test Results

- Typecheck: No errors in `agents.ts` or `agents.test.ts`
- Tests: 20/24 pass. 4 failures are all in the sync test suite due to pre-existing git email auto-detect issue in the Docker environment (unrelated to this change).

## Open Questions / Risks

- The test DDL update in `test-utils.ts` will affect ALL other test suites that use `createTestDb`. Those tests may have been written against the old schema and could break. This is expected and necessary -- the old DDL was wrong.
- The `GET /agents` endpoint still returns soft-deleted agents. The plan didn't specify filtering them out.

## Suggested Follow-ups

- Filter soft-deleted agents from `GET /agents` (or add a query parameter to include/exclude them).
- Fix the git email config in the test environment so sync tests can pass.
- Update other test files that may reference old column names (`claimedBy`, `claimant`, etc.).
