---
title: "Chat rooms: bidirectional human-agent and agent-agent communication"
priority: high
reported-by: interactive-session
date: 2026-03-22
status: planned
plan: plans/chat-rooms-and-design-teams.md
plan-phases: 1-7
---

# Chat rooms

## Problem

The current messaging system is a one-way status board. Agents post progress updates (`phase_start`, `phase_complete`,
`build_result`) to channels. The human can read these, but there is no mechanism to:

1. **Send a message to a running container agent** and have it notice and respond.
2. **Have agents talk to each other** — e.g., a design team discussing architecture before handing off to an
   implementer.
3. **Hold a multi-party conversation** — the human, two design agents, and an implementer all in one room.

The claim/resolve model on messages is for work-item handoff, not conversation. The polling model (
`GET /messages/:channel?since=N`) is unidirectional — agents post, humans read.

## Design

### 1. Chat rooms as a new entity

Add a `rooms` table alongside (not replacing) the existing `messages` table. Messages stay for structured
status/work-item flow. Rooms are for conversation.

```sql
CREATE TABLE rooms
(
    id         TEXT PRIMARY KEY, -- human-readable slug: "design-team", "agent-1-direct"
    name       TEXT NOT NULL,    -- display name
    type       TEXT NOT NULL CHECK (type IN ('group', 'direct')),
    created_by TEXT NOT NULL,    -- agent name or "user"
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE room_members
(
    room_id   TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    member    TEXT NOT NULL, -- agent name or "user"
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (room_id, member)
);

CREATE TABLE chat_messages
(
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id    TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    sender     TEXT NOT NULL,                         -- agent name or "user"
    content    TEXT NOT NULL,                         -- plain text or markdown
    reply_to   INTEGER REFERENCES chat_messages (id), -- optional thread
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_chat_room_id ON chat_messages (room_id, id);
```

### 2. API endpoints

```
POST   /rooms                          -- create a room
GET    /rooms                          -- list rooms (optionally filter by member)
GET    /rooms/:id                      -- room details + member list
DELETE /rooms/:id                      -- delete room and all messages

POST   /rooms/:id/members              -- add member(s) to room
DELETE /rooms/:id/members/:member      -- remove member from room

POST   /rooms/:id/messages             -- post a chat message
GET    /rooms/:id/messages             -- poll messages (?since=N for long-poll, ?before=N for history)
```

**POST /rooms/:id/messages** body:

```json
{
  "content": "What do you think about using a component-based approach here?",
  "replyTo": 42
  // optional — thread reply
}
```

Sender identified via `X-Agent-Name` header (agents) or absence of header (user, identified as `"user"`).

### 3. Agent awareness — the notification file

Container agents run in non-interactive mode (`claude -p`). They cannot be interrupted mid-thought. The mechanism for
getting their attention:

**Notification file polling.** Each container mounts a shared volume at `/notifications/`. The coordination server
writes a JSON file when a message arrives in a room the agent is a member of:

```
/notifications/{agent-name}/pending.json
```

```json
{
  "rooms": {
    "design-team": {
      "unread": 3,
      "lastMessageId": 147,
      "lastSender": "user"
    },
    "agent-1-direct": {
      "unread": 1,
      "lastMessageId": 148,
      "lastSender": "user"
    }
  },
  "updatedAt": "2026-03-22T14:30:00Z"
}
```

A container instruction (`container/instructions/core/03-chat.md`) tells the agent to check
`/notifications/{agent-name}/pending.json` periodically — between phases, after builds, and when idle. If unread
messages exist, the agent reads them via `GET /rooms/:id/messages?since=N` and responds via `POST /rooms/:id/messages`.

**Why file-based, not webhook?** Claude Code runs as a single `claude -p` invocation. There is no HTTP server inside the
container to receive webhooks. File polling is the only injection point that doesn't require architectural changes to
how Claude Code operates.

**Alternative: PreToolUse hook injection.** A lighter-weight option — a PreToolUse hook that fires on every tool use and
checks for pending notifications. If messages are waiting, the hook injects an `additionalContext` prompt: "You have
unread messages in room X. After completing your current step, read and respond to them." This avoids the agent needing
to remember to poll, but adds latency to every tool call. Both approaches can coexist.

### 4. User-side interface

The dashboard gets a chat panel. For the interactive Claude Code session (the human operator), a new CLI command or
status endpoint:

```bash
# From the interactive session, post to a room
curl -X POST http://localhost:9100/rooms/design-team/messages \
  -H 'Content-Type: application/json' \
  -d '{"content": "I want to reconsider the data model. Can you sketch alternatives?"}'

# Read recent messages
curl http://localhost:9100/rooms/design-team/messages?since=0&limit=20
```

The dashboard chat panel is the primary UI. The curl commands are for scripting and the interactive Claude Code session.

### 5. Room lifecycle patterns

**Auto-created rooms:**

- When an agent registers, create a direct room `{agent-name}-direct` with members `[agent-name, "user"]`. This is the
  1:1 channel between the human and that agent.
- When a design team is configured (see issue 020), create a group room with all team members + the user.

**User-created rooms:**

- `POST /rooms` with
  `{"id": "architecture-review", "name": "Architecture Review", "type": "group", "members": ["agent-1", "agent-2", "user"]}`.

**Ephemeral rooms:**

- Rooms can be deleted when their purpose is served. Messages are cascade-deleted.

### 6. Interaction with existing messaging

The existing `messages` table and endpoints remain unchanged. They serve a different purpose:

| System                     | Purpose                    | Pattern                                                    |
|----------------------------|----------------------------|------------------------------------------------------------|
| **Messages** (`/messages`) | Structured status board    | Agent posts updates; human reads; orchestrator coordinates |
| **Chat rooms** (`/rooms`)  | Bidirectional conversation | Human asks questions; agents discuss; multi-party dialogue |

Agents continue posting `phase_start`, `phase_complete`, `build_result` to the messages board. Chat rooms are for
unstructured, conversational exchange.

### 7. Message format

Chat messages are plain text or markdown. No structured `type`/`payload` like the status board. The `reply_to` field
enables lightweight threading without full thread semantics.

For richer interactions (sharing code snippets, referencing files), the content field supports markdown code blocks. No
attachment system — agents can reference file paths, and the human can read them.

## Not in scope

- Real-time websocket push (polling is sufficient; the dashboard already polls)
- Read receipts or typing indicators
- Message editing or deletion by sender
- File attachments or media
- End-to-end encryption

These can be added later if the conversation patterns demand them.
