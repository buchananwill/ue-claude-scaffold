#!/usr/bin/env node
// Chat channel MCP server — polls the coordination server for new messages
// and pushes them into the Claude Code session as <channel> events.
//
// Replaces the old HTTP-listener approach which required host→container
// networking (broken on Windows Docker Desktop).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const SERVER_URL = process.env.SERVER_URL ?? 'http://host.docker.internal:9100';
const AGENT_NAME = process.env.AGENT_NAME ?? 'unknown';
const SESSION_TOKEN = process.env.SESSION_TOKEN ?? '';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL) || 3000;
const DISCOVERY_EVERY_N = 10; // re-discover rooms every N poll cycles

const authHeaders = {
  'Content-Type': 'application/json',
  'X-Agent-Name': AGENT_NAME,
  ...(SESSION_TOKEN ? { Authorization: `Bearer ${SESSION_TOKEN}` } : {}),
};

// ── MCP server setup ────────────────────────────────────────────────────────

const server = new Server(
  { name: 'chat-channel', version: '2.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: [
      'Chat room messages arrive as <channel> events.',
      'The "sender" attribute identifies who sent the message (an agent name or "user").',
      'The "room" attribute is the room ID. "message_id" is the message sequence number.',
      `Your agent name is "${AGENT_NAME}". Reply with the reply tool, passing the room ID from the event.`,
    ].join(' '),
  }
);

// ── Reply tool ──────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Send a message to a chat room',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: 'Room ID to post to' },
        content: { type: 'string', description: 'Message content (markdown)' },
        replyTo: { type: 'number', description: 'Optional message ID to reply to' },
      },
      required: ['room', 'content'],
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'reply') {
    return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
  }
  const { room, content, replyTo } = request.params.arguments;
  const res = await fetch(`${SERVER_URL}/rooms/${encodeURIComponent(room)}/messages`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ content, replyTo: replyTo ?? null }),
  });
  const body = await res.json();
  if (!res.ok) {
    return { content: [{ type: 'text', text: `Failed to send: ${JSON.stringify(body)}` }], isError: true };
  }
  return { content: [{ type: 'text', text: `Message sent to ${room} (id: ${body.id})` }] };
});

// ── Connect stdio transport FIRST (before any I/O) ─────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

// ── Polling loop ────────────────────────────────────────────────────────────

/** @type {Map<string, number>} */
const lastSeen = new Map();

/** @type {string[]} */
let knownRooms = [];
let pollCycle = 0;

async function discoverRooms() {
  try {
    const res = await fetch(
      `${SERVER_URL}/rooms?member=${encodeURIComponent(AGENT_NAME)}`,
      { headers: authHeaders, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return;
    const rooms = await res.json();
    knownRooms = rooms.map((r) => r.id);
  } catch {
    // Will retry next discovery cycle
  }
}

async function pollRoom(roomId) {
  const since = lastSeen.get(roomId) ?? 0;
  try {
    const res = await fetch(
      `${SERVER_URL}/rooms/${encodeURIComponent(roomId)}/messages?since=${since}&limit=50`,
      { headers: authHeaders, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return;
    const messages = await res.json();

    for (const msg of messages) {
      // Track position even for own messages, but don't emit them
      lastSeen.set(roomId, Math.max(lastSeen.get(roomId) ?? 0, msg.id));
      if (msg.sender === AGENT_NAME) continue;

      const meta = {
        room: roomId,
        sender: msg.sender,
        message_id: String(msg.id),
      };
      if (msg.replyTo) meta.reply_to = String(msg.replyTo);

      await server.notification({
        method: 'notifications/claude/channel',
        params: { content: msg.content, meta },
      });
    }
  } catch (err) {
    console.error(`[chat-channel] poll error (${roomId}):`, err.message);
  }
}

async function poll() {
  if (pollCycle % DISCOVERY_EVERY_N === 0) {
    await discoverRooms();
  }
  pollCycle++;

  for (const roomId of knownRooms) {
    await pollRoom(roomId);
  }
}

// Initial poll, then repeat on interval
poll();
setInterval(poll, POLL_INTERVAL_MS);
