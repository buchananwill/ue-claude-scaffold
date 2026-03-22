# Chat Rooms and Design Teams

Implements issues 019 (chat rooms) and 020 (design teams). Chat rooms provide the bidirectional messaging
infrastructure. Design teams consume it to enable collaborative agent groups with a chairman, deliberation protocol,
and task-queue handoff.

## Phase 1 — Schema: rooms, members, chat messages

Add three new tables to `server/src/db.ts`:

- `rooms` (id TEXT PK, name, type CHECK IN ('group','direct'), created_by, created_at)
- `room_members` (room_id FK, member TEXT, joined_at, PK(room_id, member))
- `chat_messages` (id INTEGER PK AUTOINCREMENT, room_id FK, sender, content, reply_to FK self, created_at)
- Index: `idx_chat_room_id ON chat_messages(room_id, id)`

Bump the schema version. Existing tables unchanged.

## Phase 2 — Room CRUD endpoints

New route file `server/src/routes/rooms.ts`. Register in the Fastify plugin tree.

Endpoints:

- `POST /rooms` — create room. Body: `{id, name, type, members[]}`. Auto-adds creator to members. Returns `{ok, id}`.
- `GET /rooms` — list rooms. Optional `?member=X` filter. Returns rooms with member counts.
- `GET /rooms/:id` — room detail + full member list.
- `DELETE /rooms/:id` — delete room. Cascade deletes members and messages.
- `POST /rooms/:id/members` — add member(s). Body: `{members: string[]}`.
- `DELETE /rooms/:id/members/:member` — remove member.

All endpoints identify the caller via `X-Agent-Name` header (agents) or `"user"` (no header).

## Phase 3 — Chat message endpoints

Add to `server/src/routes/rooms.ts`:

- `POST /rooms/:id/messages` — post message. Body: `{content, replyTo?}`. Sender from header. Returns `{ok, id}`.
- `GET /rooms/:id/messages` — poll messages. Query params:
  - `since=N` — ascending order, all messages after ID N (real-time poll mode).
  - `before=N` — descending order, messages before ID N (history scroll).
  - `limit` (1–500, default 100).
  - Returns messages with `id, roomId, sender, content, replyTo, createdAt`.

Validate room membership: only members can post or read. Return 403 for non-members.

## Phase 4 — Auto-create direct rooms on agent registration

Modify `server/src/routes/agents.ts`: when `POST /agents/register` succeeds, also create a direct room
`{agent-name}-direct` with members `[agent-name, "user"]`. This gives every agent a 1:1 channel with the human
from the moment it starts.

If the room already exists (agent re-registering), skip creation.

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

When `POST /rooms/:id/messages` inserts a new chat message, the coordination server must notify member
containers. Add a broadcast step after the insert:

1. Look up room members from `room_members`.
2. For each member (except the sender), look up the agent's container address from the `agents` table.
3. HTTP POST to `http://{container-host}:8788` with the message content, room ID, sender, and message ID.

This requires containers to expose port 8788 (or a configured port) on the Docker network. Add port mapping to
`docker-compose.yml`. The coordination server needs to know each container's address — store it in the `agents`
table at registration time (`container_host` column), or derive it from the Docker network name
(`container-{agent-name}:8788`).

If the POST fails (container not reachable), log and skip — the agent can still poll `GET /rooms/:id/messages`
as a fallback. Messages are persisted in the database regardless.

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
- A chairman delegating codebase research to a sub-agent will see messages when the research completes.
- The sub-agents themselves are never distracted by chat traffic.

### 5e. Authentication prerequisite

Channels require **Claude.ai login authentication**, not API key auth. Verify that the containers' Claude Code
authentication method is compatible before building this phase. If containers use API key auth, channels will
not work and the fallback is a PostToolUse hook with SubagentStart/Stop depth tracking (see issue 019 §3
alternative approach). Test this early — it is the highest-risk item in the plan.

## Phase 6 — Container instruction for chat protocol

Create `container/instructions/02-chat.md` (renumber existing `02-messages.md` to `01-messages.md` if needed):

Contents:

- You are a member of one or more chat rooms. Messages from other participants arrive as
  `<channel source="chat" room="..." sender="..." message_id="...">` events in your context.
- When you see a channel event, respond using the `reply` tool (provided by the chat channel). Do not use
  curl — the tool handles posting to the correct room.
- If a message from `user` asks you to change approach, prioritize it. User messages are directives.
- If a message from another agent proposes something, engage with it — agree, disagree, or build on it.
- Keep responses focused. This is a working conversation, not a status report.
- To read message history (e.g., catching up on a room you just joined), use:
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
- `team_members` (team_id FK, agent_name FK agents.name, role TEXT, is_chairman INTEGER DEFAULT 0,
  PK(team_id, agent_name))

The `is_chairman` column identifies the single team member who owns the deliverable and has write access. Enforced
at the application level (at most one chairman per team).

Bump schema version.

## Phase 9 — Team CRUD endpoints

New route file `server/src/routes/teams.ts`. Register in the Fastify plugin tree.

Endpoints:

- `POST /teams` — create team. Body: `{id, name, briefPath, members: [{agentName, role, isChairman?}]}`.
  Validates exactly one chairman. Auto-creates a group room with the team ID as room ID, all members + `"user"`.
  Returns `{ok, id, roomId}`.
- `GET /teams` — list teams. Optional `?status=active` filter.
- `GET /teams/:id` — team detail: members with roles, chairman flag, room link, brief path, status, deliverable.
- `DELETE /teams/:id` — dissolve team. Sets `status='dissolved'`, `dissolved_at=now()`. Does NOT delete the room
  (history is valuable). Does NOT stop containers (that is `stop.sh`'s job).
- `PATCH /teams/:id` — update status (e.g., `active` → `converging`) or set deliverable text.

## Phase 10 — Chairman agent definition

Create `agents/core/design-chairman.md`:

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
   - Read-only codebase mount for non-chairman members.
   - Normal (read-write) mount for the chairman, scoped by instruction to `plans/`.
   - No build hooks injected (design agents don't build).
5. Launch order: chairman first, then other members. The chairman reads the brief and posts a framing
   summary (what success looks like, constraints, scope) before other members begin their independent
   analysis. This ensures the team starts from the chairman's agenda, not unmediated reactions to the
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
- Chairman badge on the owning member.
- Team status (active / converging / dissolved).
- Link to the team's chat room.
- Brief and deliverable documents (rendered markdown).

## Phase 16 — Tests for teams

Write tests in `server/src/routes/teams.test.ts`:

- Team CRUD (create, list, get, dissolve).
- Chairman validation (exactly one required, reject zero or multiple).
- Auto-room creation on team creation.
- Status transitions (active → converging → dissolved).
- Deliverable storage and retrieval.
- Member-agent FK validation (agent must be registered).

## Phase 17 — Integration test: full design team flow

End-to-end test (can be manual or scripted):

1. Register three agents (architect, critic, domain-expert) + chairman.
2. Create team via `POST /teams`.
3. Verify room created with all members + user.
4. Post brief to room.
5. Simulate agent messages (post as each agent).
6. Chairman posts deliverable.
7. Chairman submits tasks via `POST /tasks/batch`.
8. Verify tasks appear in queue with correct dependencies and source paths.
9. Dissolve team. Verify room persists, team status is dissolved.
