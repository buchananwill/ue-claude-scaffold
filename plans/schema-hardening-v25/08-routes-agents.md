# Phase 8: Agents routes

Update `server/src/routes/agents.ts` to pass `projectId` into every query, adopt soft-delete semantics, check `sessionToken` on DELETE, and fix the direct-room creation to use agent UUIDs with no operator membership.

## Files

- `server/src/routes/agents.ts` (modify)

## Work

1. Every `agentsQ.*(db, name)` call becomes `agentsQ.*(db, request.projectId, name)`. Apply throughout the file.
2. `POST /agents/register` (currently at line 44) — the new `register()` from Phase 5 generates and inserts a UUID v7 `id` itself. No change needed at the route level for id generation. However, the return shape now includes `id` — update the JSON response body to include `id` alongside the existing `sessionToken`. The container reads `sessionToken` but does not yet read `id`; exposing `id` is forward-compatible.
3. At line 74 (direct-room creation for a newly-registered agent), the current code calls `addMember(db, roomId, name)` for the agent and `addMember(db, roomId, 'user')` for the operator:
   - Replace the agent-side call with `roomsQ.addMember(db, roomId, newAgent.id)` — the UUID returned by `register()`.
   - Delete the operator-side `addMember(db, roomId, 'user')` call outright. Under Option D the operator is not a room member; their access is implicit via the route layer's operator short-circuit in Phase 9.
4. `POST /agents/:name/status` (currently at line 102) — pass `request.projectId` to `updateStatus`. Validate the incoming status against the allowed set: `{'idle', 'working', 'done', 'error', 'paused', 'stopping'}`. Explicitly forbid the value `'deleted'` — clients cannot soft-delete via this endpoint. Return `400 Bad Request` on unknown or forbidden values, with body `{ error: 'invalid_status', allowed: [...] }`.
5. `DELETE /agents/:name` (currently lines 120–146) — single-phase soft-delete. Rewrite:
   - Accept an optional query parameter `sessionToken: string`.
   - Resolve the agent by `agentsQ.getByName(db, request.projectId, name)`. If not found, return `404`.
   - If `sessionToken` was provided and `agent.sessionToken !== sessionToken`, return `409 Conflict` with body `{ error: 'session token mismatch — another container has taken over this agent slot' }`. Log the mismatch at warn level so it appears in the server log.
   - If `sessionToken` was absent, skip the check. This preserves operator and dashboard compatibility — the scoped operator has implicit authority.
   - Inside `db.transaction`:
     - `await agentsQ.softDelete(tx, request.projectId, name)` — sets `status = 'deleted'`.
     - `await filesQ.releaseByClaimantAgentId(tx, request.projectId, agent.id)` — NULLs `claimant_agent_id` / `claimed_at` on this project's files owned by this UUID.
     - `await tasksLifecycleQ.releaseByAgent(tx, request.projectId, agent.id)` — resets this project's tasks claimed by this UUID back to `pending`.
   - Return `{ ok: true, deleted: true }`.
   - Remove the old "first call sets stopping, second call hard-deletes" two-phase logic. It is replaced by a single-phase soft-delete.
6. `DELETE /agents` (bulk, currently lines 148–158) — rescope to `request.projectId` and make it soft-delete. Inside `db.transaction`:
   - `const count = await agentsQ.deleteAllForProject(tx, request.projectId)`.
   - `await filesQ.releaseAll(tx, request.projectId)`.
   - `await tasksLifecycleQ.releaseAllActive(tx, request.projectId)`.
   - Return `{ ok: true, deletedCount: count }`.
7. `POST /agents/:name/sync` (currently at line 161) — pass `request.projectId` to `agentsQ.getWorktreeInfo`. The branch merge logic below is already project-aware via `agent.projectId` but verify it reads from the scoped lookup.
8. `GET /agents/:name` (currently at line 93) — pass `request.projectId` to `agentsQ.getByName`. 404 when not found in this project.
9. `GET /agents` (list) — already takes `projectId` via the query param or request header. Verify it remains correct and does not fall through to any unscoped branch.
10. Commit. Message: `Phase 8: routes/agents.ts — project scoping, soft-delete, session-token DELETE, Option D direct-room fix`.

## Acceptance criteria

- Every `agentsQ.*` call in `server/src/routes/agents.ts` passes `request.projectId` as the second argument (after `db`).
- `POST /agents/:name/status` rejects the value `'deleted'` with a 400.
- `DELETE /agents/:name` is single-phase soft-delete; on mismatched `sessionToken` query parameter, returns 409.
- `DELETE /agents` (bulk) is scoped to `request.projectId` and soft-deletes.
- The direct-room creation at line 74 uses `newAgent.id` and does not call `addMember(..., 'user')`.
- Targeted typecheck of the file shows no errors. Errors elsewhere (routes/rooms.ts, team-launcher, etc.) are expected until Phase 9 lands.
- Commit exists.
