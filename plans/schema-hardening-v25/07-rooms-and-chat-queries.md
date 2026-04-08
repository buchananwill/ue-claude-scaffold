# Phase 7: Rooms and chat query layer (Option D)

Rewrite `server/src/queries/rooms.ts` and `server/src/queries/chat.ts` to the Option D shape: `room_members` is agent-only, `chat_messages` carries an `author_type` discriminator, operator messages are authored without being a room member. The agent-visible HTTP response shape (`sender` field on message objects) is preserved by a computed COALESCE join on read.

## Files

- `server/src/queries/rooms.ts` (modify)
- `server/src/queries/chat.ts` (modify)

## Work

1. `server/src/queries/rooms.ts` — add `import { v7 as uuidv7 } from 'uuid';` at the top. Import `agents` from `../schema/tables.js` alongside the existing imports.
2. Rewrite `addMember(db, roomId, member: string)` to `addMember(db: DbOrTx, roomId: string, agentId: string)`. Body:
   ```ts
   await db
     .insert(roomMembers)
     .values({ id: uuidv7(), roomId, agentId })
     .onConflictDoNothing({ target: [roomMembers.roomId, roomMembers.agentId] });
   ```
3. Rewrite `removeMember` to `removeMember(db: DbOrTx, roomId: string, agentId: string)`. Where-clause: `and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId))`.
4. Rewrite `getMembers(db, roomId)` to return `Array<{ agentId: string; name: string }>`. Query:
   ```ts
   return db
     .select({ agentId: roomMembers.agentId, name: agents.name })
     .from(roomMembers)
     .innerJoin(agents, eq(agents.id, roomMembers.agentId))
     .where(eq(roomMembers.roomId, roomId))
     .orderBy(agents.name);
   ```
5. Rewrite `getPresence(db, roomId)` — replace the old LEFT JOIN on `agents.name = room_members.member` with an INNER JOIN on `agents.id = room_members.agent_id`. There are no dangling members under the new FK, so INNER is correct. Filter out deleted agents: add `and(eq(roomMembers.roomId, roomId), ne(agents.status, 'deleted'))` to the where-clause. Return shape stays `{ name, joinedAt, online, status }`. Sources `name` from `agents.name`, `status` from `agents.status`, `online` as `true` for any non-deleted row (the row's existence means the agent is registered in this project).
6. Rewrite `listRooms(db, { member, projectId })`. When `opts.member` is present, resolve the agent via `(opts.projectId, opts.member) → agents.id` first (use a subquery or an explicit SELECT, whichever reads cleaner in Drizzle), then join `room_members` on `agent_id = <that id>`. If no agent matches (unknown name or unknown project), return an empty list — do not 404. This preserves the MCP server's retry loop semantics. Do NOT fall back to name-matching. The `opts.member` parameter name stays stable for API compatibility with the existing HTTP route; only the internal semantic changes.
7. `server/src/queries/chat.ts` — rewrite `SendMessageOpts` interface:
   ```ts
   export interface SendMessageOpts {
     roomId: string;
     authorType: 'agent' | 'operator' | 'system';
     authorAgentId: string | null;
     content: string;
     replyTo?: number | null;
   }
   ```
8. Rewrite `sendMessage(db, opts)` to insert `authorType` and `authorAgentId` explicitly. The CHECK constraint enforces the invariant; invalid combinations throw from the DB layer, which is what we want.
9. Rewrite `getHistory(db, roomId, opts)`. The returned rows need a `sender` field for compatibility with the existing HTTP response shape — the MCP server at `container/mcp-servers/chat-channel.mjs` reads `msg.sender` to display author names, and the dashboard reads it too. Rewrite to LEFT JOIN `agents` on `agents.id = chat_messages.author_agent_id` and SELECT a computed `sender` column:
   ```sql
   SELECT
     chat_messages.id,
     chat_messages.room_id,
     chat_messages.author_type,
     chat_messages.author_agent_id,
     chat_messages.content,
     chat_messages.reply_to,
     chat_messages.created_at,
     COALESCE(
       agents.name,
       CASE chat_messages.author_type
         WHEN 'operator' THEN 'user'
         WHEN 'system' THEN 'system'
       END
     ) AS sender
   FROM chat_messages
   LEFT JOIN agents ON agents.id = chat_messages.author_agent_id
   WHERE chat_messages.room_id = $1
   ...
   ```
   Express this via Drizzle's `select({ ... })` builder with `sql\`COALESCE(...)\`.as('sender')`. The `ORDER BY` and cursor logic on `chat_messages.id` is unchanged. This preserves the agent-visible HTTP response shape exactly, so no container code changes.
10. Rename `isMember(db, roomId, member: string)` to `isAgentMember(db, roomId: string, agentId: string)`. Rewrite the query to match on `room_members.agent_id = agentId`. The route-layer callers (Phase 9) are responsible for resolving the caller's name to an agent UUID first. Delete the old string-match version — no fallback.
11. Commit. Message: `Phase 7: Rewrite rooms and chat queries for Option D (agent-only membership, typed message authorship)`.

## Acceptance criteria

- `server/src/queries/rooms.ts` has no `'user'` string references.
- `addMember`, `removeMember`, `getMembers`, `getPresence`, `listRooms` all operate via `agents.id` (UUID), not `member` text.
- `getPresence` filters out `status = 'deleted'` rows.
- `server/src/queries/chat.ts` exports the new `SendMessageOpts` with `authorType` and `authorAgentId`; no `sender` parameter.
- `sendMessage` writes to `author_type` and `author_agent_id`.
- `getHistory` returns rows with a computed `sender` field via COALESCE + LEFT JOIN on `agents`.
- `isAgentMember` exists; `isMember` is gone.
- Targeted typecheck of each file shows no errors in the file itself. Caller errors elsewhere are expected.
- Commit exists.
