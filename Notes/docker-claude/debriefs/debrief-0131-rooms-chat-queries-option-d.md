# Debrief 0131 — Rooms and Chat Queries Option D Rewrite

## Task Summary

Rewrite `server/src/queries/rooms.ts` and `server/src/queries/chat.ts` to the Option D shape: `room_members` is agent-only (keyed by `agent_id` UUID), `chat_messages` carries an `author_type` discriminator, and operator messages are authored without being a room member. The agent-visible HTTP response shape (`sender` field on message objects) is preserved by a computed COALESCE join on read.

## Changes Made

- **server/src/queries/rooms.ts** — Rewrote all member-related functions to use `agentId` (UUID) instead of `member` (text string). Added `uuid` import for `uuidv7()`. `addMember` now generates a UUID primary key and uses `onConflictDoNothing` targeting the unique constraint on `(roomId, agentId)`. `removeMember` and `getMembers` use `agentId`. `getPresence` uses INNER JOIN on `agents.id = roomMembers.agentId` and filters out `status = 'deleted'` agents. `listRooms` resolves `opts.member` (agent name) to an agent ID first, then joins on `room_members.agent_id`. Removed unused `sql` import, added `ne` import.

- **server/src/queries/chat.ts** — Replaced `SendMessageOpts.sender` with `authorType` and `authorAgentId`. `sendMessage` inserts these new fields. `getHistory` LEFT JOINs `agents` on `author_agent_id` and computes a `sender` column via `COALESCE(agents.name, CASE author_type ...)`. Renamed `isMember` to `isAgentMember` with `agentId` parameter. Added `agents` and `sql` to imports.

## Design Decisions

- `listRooms` does an explicit SELECT to resolve agent name to ID rather than a subquery, for clarity. Returns empty array if no agent found (no 404).
- `getHistory` extracts `historySelect` and `senderColumn` as module-level constants to avoid repetition across the three cursor branches. Uses a `baseQuery` pattern for DRY cursor logic.
- `getPresence` returns `online: true` for all rows since deleted agents are filtered out by the WHERE clause, matching the plan's specification that any non-deleted row is online.

## Build & Test Results

Pending initial build.

## Open Questions / Risks

- Callers of the old `isMember`, `addMember(db, roomId, memberString)`, `removeMember`, and `getMembers` signatures in route files will break. This is expected per the task — only errors in rooms.ts and chat.ts themselves should be fixed.
- The `baseQuery` pattern in `getHistory` uses Drizzle's query builder chaining; if Drizzle creates a new query instance on each `.where()` call (which it does), this is safe and does not mutate the base.

## Suggested Follow-ups

- Update route files (`server/src/routes/rooms.ts`, etc.) to pass agent IDs instead of name strings to the rewritten query functions.
- Add tests for the new `isAgentMember` function and the COALESCE sender computation in `getHistory`.
