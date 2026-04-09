# Phase 12: Test updates and new regression tests

Update every test file affected by the schema and signature changes. Add new regression tests for the specific bugs this plan closes: cross-project isolation, session-token mismatch, agent reactivation, and Option D agent/operator authorship.

## Files

- `server/src/queries/agents.test.ts` (modify)
- `server/src/routes/agents.test.ts` (modify)
- `server/src/queries/tasks-lifecycle.test.ts` (modify)
- `server/src/queries/files.test.ts` (modify)
- `server/src/queries/ubt.test.ts` (modify)
- `server/src/queries/coalesce.test.ts` (modify)
- `server/src/queries/chat.test.ts` (modify, if present)
- `server/src/queries/rooms.test.ts` (modify, if present)
- `server/src/routes/tasks.test.ts` (modify)
- `server/src/routes/build.test.ts` (modify)
- `server/src/routes/ubt.test.ts` (modify)
- `server/src/routes/coalesce.test.ts` (modify)
- `server/src/routes/rooms.test.ts` (modify — add chat protocol test cases)

## Work

1. `server/src/queries/agents.test.ts`:
   - Every `register()` call must assert the new return shape (it now populates `id`).
   - Every call to `getByName`, `updateStatus`, `softDelete`, `getWorktreeInfo`, `getActiveNames` must pass explicit `projectId`.
   - Delete or rewrite any test that asserted `hardDelete` removes the row — `hardDelete` is gone. Replace with `softDelete` tests that assert `status = 'deleted'` and the row is still present.
   - Delete or rewrite any test that asserted `deleteAll` nukes the whole table — replace with `deleteAllForProject` tests.
2. `server/src/routes/agents.test.ts`:
   - Every request builder must set `X-Project-Id` explicitly instead of relying on the default. Tests that depended on the `'default'` column default must be updated.
   - Delete or rewrite any test that asserted the two-phase DELETE (first call sets stopping, second hard-deletes) — the new flow is single-phase soft-delete.
   - Add a new `describe` block `'schema hardening V2.5 regressions'` with these cases:
     - **Cross-project coexistence.** Register `agent-1` in project `alpha` and `agent-1` in project `beta`. Assert both rows exist in the DB with distinct `id` values and the correct `project_id` values. Assert `GET /agents/agent-1` with `X-Project-Id: alpha` returns alpha's row and with `X-Project-Id: beta` returns beta's row.
     - **Cross-project DELETE isolation.** Register `agent-1` in projects alpha and beta. Claim a task in project beta with that `agent-1`. Send `DELETE /agents/agent-1` with header `X-Project-Id: alpha`. Assert the task in project beta is still `in_progress` and its `claimed_by_agent_id` is unchanged. Assert alpha's agent row has `status = 'deleted'` and beta's is untouched.
     - **Session token mismatch.** Register `agent-1` in project alpha, capture `sessionToken`. Send `DELETE /agents/agent-1?sessionToken=deadbeef00000000deadbeef00000000` with header `X-Project-Id: alpha`. Assert `409 Conflict`. Send the same DELETE without `sessionToken`. Assert `200` and the row's status is `'deleted'`. Send a second DELETE without `sessionToken`. Assert it returns `200` without changing state, or is otherwise idempotent.
     - **Reactivation.** Register `agent-1` in project alpha, soft-delete it, then register `agent-1` in project alpha again. Assert the `id` is unchanged (reactivation, not new UUID) and the status is back to `'idle'` and `sessionToken` is rotated.
3. `server/src/queries/tasks-lifecycle.test.ts`, `files.test.ts`, `coalesce.test.ts` — each gains explicit `projectId` arguments. `ubt.test.ts` — UBT queries are host-level and take NO `projectId`. Update UBT tests to pass `agentId` (UUID) instead of agent name strings; remove any `projectId` arguments from UBT call sites. All test files: tests that were passing agent names to claim/release round-trips need to first `register()` the agent to get a UUID, then pass the UUID to the query. If a test was creating rows directly via Drizzle `insert` against one of the renamed columns, update the column name.
4. `server/src/queries/chat.test.ts` (if present) — update every `sendMessage` call to the new `SendMessageOpts` shape: `{ roomId, authorType, authorAgentId, content, replyTo }`. Tests that were checking the `sender` column on reads should check that `getHistory` returns a `sender` field matching `agents.name` for agent messages, `'user'` for operator messages, `'system'` for system messages.
5. `server/src/queries/rooms.test.ts` (if present) — `addMember` / `removeMember` now take agent UUIDs. Pre-register agents in setup, pass UUIDs to the functions. `isAgentMember` tests replace `isMember` tests.
6. `server/src/routes/tasks.test.ts`, `build.test.ts`, `coalesce.test.ts` — set `X-Project-Id` explicitly on requests. `ubt.test.ts` — UBT routes are host-level; `X-Project-Id` is irrelevant for UBT endpoints (the server still reads it from the request but UBT handlers ignore it). All route tests: register agents via the `/agents/register` route (not via Drizzle inserts) so test agents have valid UUIDs.
7. `server/src/routes/rooms.test.ts` — add a new `describe` block `'Option D agent/operator authorship'` with these cases:
   - **Agent-authored message, is member.** Register `agent-1` in project alpha via the route. Create a direct room for it. POST `/rooms/{room-id}/messages` with `X-Agent-Name: agent-1` and `X-Project-Id: alpha` and a content body. Assert 200. Assert the returned message has `sender: 'agent-1'` via a follow-up GET.
   - **Agent-authored message, not member.** Register `agent-1`. Create a room WITHOUT adding agent-1 as a member. POST with `X-Agent-Name: agent-1`. Assert 403 `{ error: 'not_a_member' }`.
   - **Operator-authored message.** Create a room. POST `/rooms/{room-id}/messages` with NO `X-Agent-Name` header (but with `X-Project-Id: alpha`). Assert 200. Assert the message is stored with `author_type = 'operator'` and `author_agent_id = null`. Assert `getHistory` returns it with `sender: 'user'`.
   - **GET with agent header, not member.** Register `agent-1`, create a room without adding the agent. GET `/rooms/{room-id}/messages` with `X-Agent-Name: agent-1`. Assert 403.
   - **GET without agent header (operator read).** Same setup. GET without `X-Agent-Name`. Assert 200 and returns messages.
   - **Unknown agent header.** Register no agents. POST with `X-Agent-Name: ghost` and `X-Project-Id: alpha`. Assert 403 `{ error: 'unknown_agent' }`.
8. Commit. Message: `Phase 12: Test updates + cross-project isolation + session-token + reactivation + Option D authorship regression tests`.

## Acceptance criteria

- Every test file listed above compiles (typecheck passes on test files too after this phase).
- New regression tests in `routes/agents.test.ts` cover: cross-project coexistence, cross-project DELETE isolation, session-token mismatch, reactivation.
- New tests in `routes/rooms.test.ts` cover: agent-authored (member and non-member), operator-authored, GET with/without agent header, unknown agent.
- Tests that relied on removed functions (`hardDelete`, `deleteAll`, two-phase DELETE, `isMember`, old `sendMessage` sender field) are rewritten, not stubbed out.
- Commit exists.
