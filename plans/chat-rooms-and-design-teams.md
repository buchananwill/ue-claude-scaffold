# Chat Rooms and Design Teams

Implements issues 019 (chat rooms) and 020 (design teams). Chat rooms provide the bidirectional messaging
infrastructure. Design teams consume it to enable collaborative agent groups with a discussion leader, deliberation protocol,
and task-queue handoff.

## Design decisions (2026-03-23)

Resolved during design session. These are binding — do not re-litigate during implementation.

1. **Push failure handling.** Log and skip on delivery failure. No retry queue. The push payload carries the full
   message content plus unread-count metadata, so the agent can act immediately on new messages and detect missed
   ones without polling. Messages are always persisted in the DB regardless of push success.

2. **Dashboard read access.** GET requests with no `X-Agent-Name` header (i.e., the dashboard or operator) bypass
   membership checks and can read any room. This is tooling autonomy auditing, not surveillance. Posting to a
   room requires explicit membership so that members see "user" appear as a participant.

3. **Container host discovery.** Registration-based. Agents report `container_host` in `POST /agents/register`.
   The coordination server uses this to push messages. Add `container_host TEXT` column to the `agents` table.

4. **Pending room members.** `room_members.member` is plain `TEXT` with no FK to `agents`. Teams and rooms can
   pre-create memberships for agents that haven't registered yet. On agent registration, the server checks for
   pre-existing room memberships and begins pushing to the new agent immediately.

5. **Auth compatibility.** Confirmed. Container auth protocol (Max plan OAuth token) is compatible with Claude Code
   channels. Phase 5e risk is retired.

6. **Implementation order.** Phases 1–7 first (chat rooms). Validate with real container messaging before building
   teams (phases 8+).

## Phase 1 — Schema: rooms, members, chat messages

Add three new tables to `server/src/db.ts`:

- `rooms` (id TEXT PK, name, type CHECK IN ('group','direct'), created_by, created_at)
- `room_members` (room_id FK, member TEXT, joined_at, PK(room_id, member)) — no FK to agents; supports pending members
- `chat_messages` (id INTEGER PK AUTOINCREMENT, room_id FK, sender, content, reply_to FK self, created_at)
- Index: `idx_chat_room_id ON chat_messages(room_id, id)`

Add `container_host TEXT` column to the `agents` table (migration).

Bump the schema version. Existing tables unchanged.

## Phase 2 — Room CRUD endpoints

New route file `server/src/routes/rooms.ts`. Register in the Fastify plugin tree.

Endpoints:

- `POST /rooms` — create room. Body: `{id, name, type, members[]}`. Auto-adds creator to members. Returns `{ok, id}`.
- `GET /rooms` — list rooms. Optional `?member=X` filter. Returns rooms with member counts.
  No membership check when called without `X-Agent-Name` header (dashboard/operator access).
- `GET /rooms/:id` — room detail + full member list. Same dashboard-open read policy.
- `DELETE /rooms/:id` — delete room. Cascade deletes members and messages.
- `POST /rooms/:id/members` — add member(s). Body: `{members: string[]}`.
- `DELETE /rooms/:id/members/:member` — remove member.

All endpoints identify the caller via `X-Agent-Name` header (agents) or `"user"` (no header).

## Phase 3 — Chat message endpoints

Add to `server/src/routes/rooms.ts`:

- `POST /rooms/:id/messages` — post message. Body: `{content, replyTo?}`. Sender from header. Returns `{ok, id}`.
  **Posting requires membership.** Return 403 for non-members. The sender must appear in `room_members`.
- `GET /rooms/:id/messages` — poll messages. Query params:
  - `since=N` — ascending order, all messages after ID N (real-time poll mode).
  - `before=N` — descending order, messages before ID N (history scroll).
  - `limit` (1–500, default 100).
  - Returns messages with `id, roomId, sender, content, replyTo, createdAt`.
  **Reading is open** when called without `X-Agent-Name` header (dashboard/operator). Agents must be members.

After inserting a message, broadcast to member containers (see phase 5b).

## Phase 4 — Auto-create direct rooms on agent registration

Modify `server/src/routes/agents.ts`: when `POST /agents/register` succeeds:

1. Create a direct room `{agent-name}-direct` with members `[agent-name, "user"]`. This gives every agent a 1:1
   channel with the human from the moment it starts. If the room already exists (agent re-registering), skip creation.

2. Check `room_members` for any pre-existing memberships for this agent name (e.g., rooms created by a team before
   the agent registered). The agent is now reachable — the server can begin pushing to it immediately. No action
   needed beyond storing `container_host` in the agents table; the push logic in phase 5b resolves addresses at
   send time.

Accept `container_host` in the registration body. Store it in the `agents` table.

## Phase 5 — Chat channel MCP server (container-side)

Chat notifications are delivered to containers via a **Claude Code channel** — an MCP server that pushes events
directly into the top-level Claude session. No hooks, no polling, no sidecar. Channel events are injected into
the parent session's context and are invisible to sub-agents (they have their own context windows), so top-level
filtering is automatic.

### 5a. Channel MCP server

Create `container/mcp-servers/chat-channel.ts` — a Bun/Node MCP server (~60 lines).

The server:

1. Declares `experimental: { 'claude/channel': {} }` capability (registers as a push channel).
2. Declares `tools: {}` capability (exposes a reply tool for two-way chat).
3. Listens on `localhost:8788` inside the container for HTTP POSTs from the coordination server.
4. On receiving a POST, emits a notification into the Claude session:

```typescript
await mcp.notification({
  method: 'notifications/claude/channel',
  params: {
    content: messageContent,
    meta: { room: roomId, sender: senderName, message_id: String(msgId) }
  }
})
```

5. Exposes a `reply` tool so Claude can respond without needing to `curl`:

```typescript
tools: [{
  name: 'reply',
  description: 'Send a message to a chat room',
  inputSchema: {
    type: 'object',
    properties: {
      room: { type: 'string', description: 'Room ID to post to' },
      content: { type: 'string', description: 'Message content (markdown)' },
      replyTo: { type: 'number', description: 'Optional message ID to reply to' }
    },
    required: ['room', 'content']
  }
}]
```

The reply tool handler POSTs to `$SERVER_URL/rooms/:room/messages` with the `X-Agent-Name` header.

Claude sees incoming messages as:
```xml
<channel source="chat" room="design-team" sender="user" message_id="147">
What do you think about using a component-based approach here?
</channel>
```

### 5b. Server-side push to containers

When `POST /rooms/:id/messages` inserts a new chat message, the coordination server broadcasts to member
containers. The push payload carries the full message so the agent can act on it immediately, plus room-level
metadata so the agent knows if it missed anything.

Broadcast logic after insert:

1. Look up room members from `room_members`.
2. For each member (except the sender), look up the agent's `container_host` from the `agents` table.
   If the agent has no row in `agents` (pending member, not yet registered), skip silently.
3. HTTP POST to `http://{container_host}:8788` with payload:

```json
{
  "roomId": "design-team",
  "message": {
    "id": 147,
    "sender": "user",
    "content": "What do you think about using a component-based approach here?",
    "replyTo": null,
    "createdAt": "2026-03-23T14:30:00Z"
  },
  "roomMeta": {
    "unread": 3,
    "lastMessageId": 147,
    "lastSender": "user"
  }
}
```

The `roomMeta.unread` count is computed per-recipient (messages in this room after the last message sent by
that agent). This lets the agent detect gaps: if it receives a push with `unread: 5` but only has context for
the current message, it knows to poll `GET /rooms/:id/messages?since=N` for the 4 it missed.

4. On push failure (connection refused, timeout), log a warning and continue. No retry. The message is persisted
   in the DB; the agent catches up on the next successful push or explicit poll.

Container port 8788 must be exposed on the Docker network. Add to `docker-compose.yml`.

### 5c. Container launch integration

The entrypoint configures the channel:

1. Add the MCP server to the container's `.mcp.json`:
   ```json
   { "mcpServers": { "chat": { "command": "bun", "args": ["./mcp-servers/chat-channel.ts"] } } }
   ```
2. Launch Claude Code with the channel enabled:
   ```bash
   claude -p "$PROMPT" --channels server:chat --dangerously-load-development-channels
   ```
3. The `--dangerously-load-development-channels` flag is required because custom channels are a research
   preview. Containers already run with permissive flags, so this is acceptable.

### 5d. Sub-agent isolation (automatic)

Channel events push into the **top-level Claude session's context**. Sub-agents spawned via the Agent tool
operate in their own context windows and never see channel events. When a sub-agent finishes and control returns
to the top-level agent, it sees any channel events that arrived during the sub-agent's execution. No depth
tracking, no hook filtering, no conditional injection needed.

This means:
- An orchestrator delegating to an implementer sub-agent will see chat messages when the implementer returns.
- A discussion leader delegating codebase research to a sub-agent will see messages when the research completes.
- The sub-agents themselves are never distracted by chat traffic.

### 5e. Authentication — confirmed compatible

Container auth (Max plan OAuth token) satisfies the Claude.ai login requirement for channels. No fallback
mechanism needed. Risk retired.

## Phase 6 — Container instruction for chat protocol

Create `container/instructions/02-chat.md` (renumber existing `02-messages.md` to `01-messages.md` if needed):

Contents:

- You are a member of one or more chat rooms. Messages from other participants arrive as
  `<channel source="chat" room="..." sender="..." message_id="...">` events in your context.
- When you see a channel event, respond using the `reply` tool (provided by the chat channel). Do not use
  curl — the tool handles posting to the correct room.
- If a channel event includes `unread` > 1 and you don't have context for all prior messages, catch up:
  `curl GET $SERVER_URL/rooms/{room}/messages?since={your_last_known_id}&limit=50`.
- If a message from `user` asks you to change approach, prioritize it. User messages are directives.
- If a message from another agent proposes something, engage with it — agree, disagree, or build on it.
- Keep responses focused. This is a working conversation, not a status report.
- To read full message history (e.g., catching up on a room you just joined), use:
  `curl GET $SERVER_URL/rooms/{room}/messages?since=0&limit=50`.

## Phase 7 — Tests for rooms and chat

Write tests in `server/src/routes/rooms.test.ts` using the existing test-helper pattern (isolated Fastify + temp
SQLite). Cover:

- Room CRUD (create, list, get, delete, cascade delete of messages).
- Member management (add, remove, membership validation).
- Message posting and polling (since/before modes, ordering, limit).
- Auto-direct-room creation on agent registration.
- Non-member access rejection (403).
- Reply-to threading (valid and invalid reply targets).

## Phase 8 — Schema: teams and team members

Add two new tables to `server/src/db.ts`:

- `teams` (id TEXT PK, name, brief_path, status CHECK IN ('active','converging','dissolved'), deliverable TEXT,
  created_at, dissolved_at)
- `team_members` (team_id FK, agent_name FK agents.name, role TEXT, is_leader INTEGER DEFAULT 0,
  PK(team_id, agent_name))

The `is_leader` column identifies the single team member who owns the deliverable and has write access. Enforced
at the application level (at most one discussion leader per team).

Bump schema version.

## Phase 9 — Team CRUD endpoints

New route file `server/src/routes/teams.ts`. Register in the Fastify plugin tree.

Endpoints:

- `POST /teams` — create team. Body: `{id, name, briefPath, members: [{agentName, role, isLeader?}]}`.
  Validates exactly one discussion leader. Auto-creates a group room with the team ID as room ID, all members + `"user"`.
  Returns `{ok, id, roomId}`.
- `GET /teams` — list teams. Optional `?status=active` filter.
- `GET /teams/:id` — team detail: members with roles, leader flag, room link, brief path, status, deliverable.
- `DELETE /teams/:id` — dissolve team. Sets `status='dissolved'`, `dissolved_at=now()`. Does NOT delete the room
  (history is valuable). Does NOT stop containers (that is `stop.sh`'s job).
- `PATCH /teams/:id` — update status (e.g., `active` → `converging`) or set deliverable text.

## Phase 10 — Discussion Leader agent definition

Create `agents/core/design-leader.md`:

Role: Advocate for the user's brief. Mediate the design team's discussion. Own the final deliverable.

Key rules:

- You are NOT a design participant. Do not propose architectures or solutions. Your job is to ensure the team's
  output satisfies the brief.
- Read the brief thoroughly before the discussion starts. Post a summary of what the brief requires and what
  success looks like.
- Let members propose and debate. Intervene when: discussion is circular, a member is ignored, or a proposal
  contradicts the brief.
- When the user signals convergence (or you judge the discussion has naturally converged), announce convergence
  and draft the deliverable.
- The deliverable is a plan document written to `plans/`. If the team decides the mandate should be split into
  separate work units, produce multiple plan files.
- After drafting, post the deliverable to the room for member review. Incorporate substantive feedback. Ignore
  style-only objections.
- After the user approves the deliverable, submit it as tasks via `POST /tasks/batch`. Do NOT launch
  orchestrators directly. The work enters the task queue and will be claimed by engineering agents when available.

Tools allowed: Read, Glob, Grep, WebFetch, WebSearch, Edit (scoped to `plans/` by instruction), Write (scoped to
`plans/` by instruction). Chat communication uses the channel's `reply` tool, not Bash/curl.

## Phase 11 — Design agent definitions

Create three agent definitions in `agents/core/`:

**`design-architect.md`** — Proposes system designs. Draws boundaries between components. Sketches data flow and
API surfaces. Reads the codebase to ground proposals in existing patterns. Posts proposals to the room as markdown.
Read-only: no Edit, Write, or Bash. Chat communication uses the channel's `reply` tool.

**`design-critic.md`** — Attacks proposals. Finds failure modes, hidden complexity, scaling problems, maintenance
burdens. Argues for simplicity when the architect over-engineers. Must provide a concrete alternative when
rejecting a proposal — "no" alone is not sufficient. Read-only. Chat via `reply` tool.

**`design-domain.md`** — Grounds the discussion in project reality. Reads existing code to identify patterns,
constraints, and migration impact. Flags when proposals conflict with existing architecture or would require
changes the brief doesn't authorize. Read-only. Chat via `reply` tool.

All three communicate exclusively through their team's chat room via channel events and the `reply` tool.

## Phase 12 — launch.sh team support

Extend `launch.sh` to accept `--team <team-id> --brief <path>`:

1. Read team definition from `teams/<team-id>.md` (or accept inline JSON).
2. Call `POST /teams` on the coordination server to register the team and create the room.
3. Post the brief as the first message in the room.
4. For each member: launch a container with:
   - Agent type from the member's `agent_type` field.
   - `CHAT_ROOM` env var set to the team's room ID.
   - `TEAM_ROLE` env var set to the member's role.
   - Read-only codebase mount for non-leader members.
   - Normal (read-write) mount for the discussion leader, scoped by instruction to `plans/`.
   - No build hooks injected (design agents don't build).
5. Launch order: discussion leader first, then other members. The discussion leader reads the brief and posts a framing
   summary (what success looks like, constraints, scope) before other members begin their independent
   analysis. This ensures the team starts from the discussion leader's agenda, not unmediated reactions to the
   raw brief.

## Phase 13 — stop.sh team support

Extend `stop.sh` to accept `--team <team-id>`:

1. Look up team members from `GET /teams/:id`.
2. Stop all member containers.
3. Call `DELETE /teams/:id` to mark team as dissolved.
4. Room and chat history persist.

## Phase 14 — Dashboard: chat panel

Add a chat panel to the dashboard:

- Room list sidebar (direct rooms, group rooms, team rooms).
- Message timeline with sender labels, timestamps, reply-to threading.
- Input box for the user to post messages.
- Unread indicators per room.
- Polls `GET /rooms/:id/messages?since=N` on the same interval as existing dashboard polling.

## Phase 15 — Dashboard: teams view

Add a teams section to the dashboard:

- Active teams with member status and roles.
- Discussion Leader badge on the owning member.
- Team status (active / converging / dissolved).
- Link to the team's chat room.
- Brief and deliverable documents (rendered markdown).

## Phase 16 — Tests for teams

Write tests in `server/src/routes/teams.test.ts`:

- Team CRUD (create, list, get, dissolve).
- Discussion leader validation (exactly one required, reject zero or multiple).
- Auto-room creation on team creation.
- Status transitions (active → converging → dissolved).
- Deliverable storage and retrieval.
- Member-agent FK validation (agent must be registered).

## Phase 17 — Integration test: full design team flow

End-to-end test (can be manual or scripted):

1. Register three agents (architect, critic, domain-expert) + discussion leader.
2. Create team via `POST /teams`.
3. Verify room created with all members + user.
4. Post brief to room.
5. Simulate agent messages (post as each agent).
6. Discussion leader posts deliverable.
7. Discussion leader submits tasks via `POST /tasks/batch`.
8. Verify tasks appear in queue with correct dependencies and source paths.
9. Dissolve team. Verify room persists, team status is dissolved.
