# Phase 9: Rooms routes and team launcher

Rewrite `server/src/routes/rooms.ts` to introduce the operator short-circuit on the POST/GET message handlers, remove the dead `'user'` membership insert in `server/src/queries/teams.ts`, and update `server/src/team-launcher.ts` to use the new `SendMessageOpts` shape.

This is the phase where the agent/operator split surfaces on the HTTP layer. The membership check at `routes/rooms.ts:168` is the critical point — miss it and the dashboard's and team-launcher's POST paths break immediately.

## Files

- `server/src/routes/rooms.ts` (modify)
- `server/src/queries/teams.ts` (modify)
- `server/src/team-launcher.ts` (modify)

## Work

1. `server/src/routes/rooms.ts` — `POST /rooms/:id/messages` (currently at line 141). Replace the existing sender-resolution logic with an explicit agent-vs-operator branch:
   - If `X-Agent-Name` header is present:
     - Resolve the agent via `agentsQ.getByName(db, request.projectId, name)`. If not found, return `403 Forbidden` with body `{ error: 'unknown_agent' }`.
     - Check `chatQ.isAgentMember(db, roomId, agent.id)`. On miss, return `403 { error: 'not_a_member' }`.
     - On hit, call `chatQ.sendMessage(db, { roomId, authorType: 'agent', authorAgentId: agent.id, content, replyTo })`.
   - If `X-Agent-Name` is absent:
     - Treat as operator write. Skip the membership check entirely — the operator has implicit access to all rooms on this local server.
     - Call `chatQ.sendMessage(db, { roomId, authorType: 'operator', authorAgentId: null, content, replyTo })`.
   - Delete the session-token fallback (currently at `routes/rooms.ts:151-156`) and the `sender ??= 'user'` line (currently at 157). They are dead code under the new scheme.
   - Return `{ ok: true, id: msg.id }` as before.
2. `GET /rooms/:id/messages` (currently at line 178) — adapt the membership check at `routes/rooms.ts:193-198`:
   - If `X-Agent-Name` is present: resolve the agent via `agentsQ.getByName(db, request.projectId, name)`, check `chatQ.isAgentMember(db, roomId, agent.id)`, return 403 on miss.
   - If `X-Agent-Name` is absent: treat as operator, skip the check.
   - The `chatQ.getHistory` call below is unchanged — it returns the join-computed `sender` field per Phase 7.
3. `GET /rooms` (list rooms handler) — verify it passes `{ member: request.query.member, projectId: request.projectId }` to `listRooms`. The Phase 7 rewrite of `listRooms` resolves the member name to an agent UUID internally using the caller's `projectId`, so cross-project isolation is automatic.
4. `POST /rooms/:id/members` and `DELETE /rooms/:id/members/:member` — these are used by team launcher and direct-room creation. The `member` parameter semantic is now "agent name to be resolved in this request's project context". Rewrite handlers to:
   - Look up the agent by `agentsQ.getByName(db, request.projectId, name)`.
   - If not found, return `404 { error: 'unknown_agent' }`.
   - Pass the UUID to `roomsQ.addMember(db, roomId, agent.id)` or `roomsQ.removeMember(db, roomId, agent.id)`.
5. `GET /rooms/:id/presence` — HTTP shape unchanged. Under the hood, `getPresence` now joins `agents` by UUID per Phase 7 and filters out deleted agents. No route-level change.
6. `GET /rooms/:id/transcript` — the raw SQL transcript query (currently at `routes/rooms.ts:222-241`) inlines `sender` from the old `chat_messages.sender` column. Rewrite the SQL to join `chat_messages` with `agents` on `author_agent_id` and compute `sender` via the same COALESCE pattern as Phase 7's `getHistory`:
   ```sql
   SELECT
     rooms.name AS room_name,
     cm.room_id AS "roomId",
     COALESCE(
       agents.name,
       CASE cm.author_type WHEN 'operator' THEN 'user' WHEN 'system' THEN 'system' END
     ) AS sender,
     cm.content,
     cm.created_at AS time
   FROM chat_messages cm
   LEFT JOIN agents ON agents.id = cm.author_agent_id
   INNER JOIN rooms ON rooms.id = cm.room_id
   WHERE ...
   ```
   The `Row` type stays the same — the caller code downstream reads `sender` as a string.
7. `server/src/queries/teams.ts` — find the `.values({ roomId: opts.id, member: 'user' })` call (currently at line 64) and delete it outright. Team room creation still adds the participating agents via the `team_members` flow elsewhere, but the operator is not a member.
8. `server/src/team-launcher.ts` — find the `chatQ.sendMessage(tx, { roomId, sender: 'user', content, replyTo })` call (currently around lines 200–210) and update to the new `SendMessageOpts` shape: `chatQ.sendMessage(tx, { roomId, authorType: 'operator', authorAgentId: null, content, replyTo })`. Functionally identical, typed correctly.
9. Commit. Message: `Phase 9: routes/rooms.ts operator short-circuit, delete dead 'user' membership, team-launcher typed author`.

## Acceptance criteria

- `POST /rooms/:id/messages` in `server/src/routes/rooms.ts` has two explicit branches: one for `X-Agent-Name` present (agent flow with membership check), one for absent (operator flow with no membership check).
- `sender ??= 'user'` and the session-token fallback at `routes/rooms.ts:151-157` are deleted.
- `GET /rooms/:id/messages` applies the same operator short-circuit on its membership check.
- `POST /rooms/:id/members` resolves names to agent UUIDs via the request's `projectId` scope before calling `addMember`.
- `GET /rooms/:id/transcript` uses the COALESCE+JOIN SQL to compute `sender`.
- `server/src/queries/teams.ts` no longer contains the `member: 'user'` insert.
- `server/src/team-launcher.ts` `sendMessage` call uses `authorType: 'operator'` and `authorAgentId: null`.
- Targeted typecheck of these three files shows no errors in the files themselves. Errors elsewhere (remaining callsites in Phase 10) are expected.
- Commit exists.
