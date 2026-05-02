#!/usr/bin/env node
// Chat channel MCP server — polls the coordination server for new messages
// and notifies the Claude session that unread messages are available.
//
// Instead of forwarding individual messages as channel events, this server:
// 1. Polls for new messages and sends a "you have N unread" notification
// 2. Provides a `check_messages` tool that returns the full conversation
//    since the agent's last reply, formatted as a structured chat log
// 3. Provides a `reply` tool to post messages back to the room

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const SERVER_URL = process.env.SERVER_URL ?? 'http://host.docker.internal:9100';
const AGENT_NAME = process.env.AGENT_NAME ?? 'unknown';
const SESSION_TOKEN = process.env.SESSION_TOKEN ?? '';
const PROJECT_ID = process.env.PROJECT_ID ?? 'default';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL) || 3000;
const DISCOVERY_EVERY_N = 10;

const log = (...args) => console.error(`[chat-channel][${AGENT_NAME}]`, ...args);

log('=== MCP SERVER STARTING ===');
log(`SERVER_URL: ${SERVER_URL}`);
log(`AGENT_NAME: ${AGENT_NAME}`);
log(`SESSION_TOKEN: ${SESSION_TOKEN ? SESSION_TOKEN.slice(0, 8) + '...' : 'NONE'}`);
log(`POLL_INTERVAL_MS: ${POLL_INTERVAL_MS}`);

const authHeaders = {
  'Content-Type': 'application/json',
  'X-Agent-Name': AGENT_NAME,
  'X-Project-Id': PROJECT_ID,
  ...(SESSION_TOKEN ? { Authorization: `Bearer ${SESSION_TOKEN}` } : {}),
};

// ── State ───────────────────────────────────────────────────────────────────

/** @type {Map<string, number>} high-water mark per room (latest message ID seen by poll) */
const highWater = new Map();

/** @type {Map<string, number>} ID of this agent's last reply per room (for check_messages) */
const lastRepliedAt = new Map();

/** @type {Map<string, number>} count of unread messages per room (messages since last check) */
const unreadCount = new Map();

/** @type {string[]} */
let knownRooms = [];
let pollCycle = 0;

// ── MCP server setup ────────────────────────────────────────────────────────

const server = new Server(
  { name: 'chat-channel', version: '3.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: [
      `Your agent name is "${AGENT_NAME}".`,
      'You will receive <channel> notifications when new messages arrive in your chat room.',
      'Use the `check_messages` tool to read the full conversation since your last reply.',
      'Use the `check_presence` tool to see who is in the room and whether they are online.',
      'Use the `reply` tool to send messages to the room.',
      'EVERY response to the team MUST go through the `reply` tool — text outside tool calls is invisible to other agents.',
    ].join(' '),
  }
);

// ── Tools ───────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  log('ListTools called');
  return {
    tools: [
      {
        name: 'check_messages',
        description: 'Read the chat room conversation since your last reply. Returns a structured log of all messages, or "No unread messages" if caught up.',
        inputSchema: {
          type: 'object',
          properties: {
            room: { type: 'string', description: 'Room ID to check' },
          },
          required: ['room'],
        },
      },
      {
        name: 'check_presence',
        description: 'Check who is in the chat room and whether they are online. Returns each member with their registration status.',
        inputSchema: {
          type: 'object',
          properties: {
            room: { type: 'string', description: 'Room ID to check' },
          },
          required: ['room'],
        },
      },
      {
        name: 'reply',
        description: 'Send a message to a chat room. EVERY message you want the team to see MUST use this tool.',
        inputSchema: {
          type: 'object',
          properties: {
            room: { type: 'string', description: 'Room ID to post to' },
            content: { type: 'string', description: 'Message content (markdown)' },
            replyTo: { type: 'number', description: 'Optional message ID to reply to' },
          },
          required: ['room', 'content'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = request.params.arguments;
  log(`CallTool: ${name}`, JSON.stringify(args));

  if (name === 'check_messages') {
    return handleCheckMessages(args.room);
  }
  if (name === 'check_presence') {
    return handleCheckPresence(args.room);
  }
  if (name === 'reply') {
    return handleReply(args.room, args.content, args.replyTo);
  }
  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

// ── check_messages handler ──────────────────────────────────────────────────

async function handleCheckMessages(roomId) {
  const since = lastRepliedAt.get(roomId) ?? 0;
  try {
    const res = await fetch(
      `${SERVER_URL}/rooms/${encodeURIComponent(roomId)}/messages?since=${since}&limit=200`,
      { headers: authHeaders, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) {
      log(`check_messages FAILED: HTTP ${res.status}`);
      return { content: [{ type: 'text', text: `Failed to fetch messages: HTTP ${res.status}` }], isError: true };
    }
    const messages = await res.json();
    log(`check_messages room=${roomId} since=${since}: ${messages.length} message(s)`);

    // Update high water mark
    for (const msg of messages) {
      highWater.set(roomId, Math.max(highWater.get(roomId) ?? 0, msg.id));
    }

    // Reset unread count — agent has now seen everything
    unreadCount.set(roomId, 0);

    // Filter out own messages for the display, but track their position
    const otherMessages = [];
    for (const msg of messages) {
      if (msg.sender === AGENT_NAME) {
        // Track own messages in the log so agent sees conversation flow
        otherMessages.push(msg);
      } else {
        otherMessages.push(msg);
      }
    }

    if (otherMessages.length === 0) {
      return { content: [{ type: 'text', text: 'No unread messages.' }] };
    }

    // Format as structured conversation log
    const lines = otherMessages.map((msg) => {
      const tag = msg.sender === AGENT_NAME ? `[${msg.sender} (you)]` : `[${msg.sender}]`;
      return `${tag} (msg #${msg.id})\n${msg.content}`;
    });

    const header = `--- CHAT ROOM: ${roomId} — ${otherMessages.length} message(s) since your last reply ---`;
    const footer = `--- END — Use \`reply\` tool to respond (room: "${roomId}") ---`;
    const text = [header, '', ...lines.join('\n\n').split('\n'), '', footer].join('\n');

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    log(`check_messages ERROR: ${err.message}`);
    return { content: [{ type: 'text', text: `Error checking messages: ${err.message}` }], isError: true };
  }
}

// ── check_presence handler ───────────────────────────────────────────────────

async function handleCheckPresence(roomId) {
  try {
    const res = await fetch(
      `${SERVER_URL}/rooms/${encodeURIComponent(roomId)}/presence`,
      { headers: authHeaders, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) {
      log(`check_presence FAILED: HTTP ${res.status}`);
      return { content: [{ type: 'text', text: `Failed to check presence: HTTP ${res.status}` }], isError: true };
    }
    const data = await res.json();
    log(`check_presence room=${roomId}: ${data.members.length} member(s)`);

    const lines = data.members.map((m) => {
      const icon = m.online ? '●' : '○';
      return `${icon} ${m.name} — ${m.status}`;
    });

    const text = `--- ROOM PRESENCE: ${roomId} ---\n${lines.join('\n')}\n--- ● = online, ○ = not registered ---`;
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    log(`check_presence ERROR: ${err.message}`);
    return { content: [{ type: 'text', text: `Error checking presence: ${err.message}` }], isError: true };
  }
}

// ── reply handler ───────────────────────────────────────────────────────────

async function handleReply(roomId, content, replyTo) {
  try {
    const res = await fetch(`${SERVER_URL}/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ content, replyTo: replyTo ?? null }),
    });
    const body = await res.json();
    if (!res.ok) {
      log(`Reply FAILED: HTTP ${res.status}`, JSON.stringify(body));
      return { content: [{ type: 'text', text: `Failed to send: ${JSON.stringify(body)}` }], isError: true };
    }
    log(`Reply OK: room=${roomId}, id=${body.id}, content="${content.slice(0, 80)}..."`);

    // Update lastRepliedAt so check_messages starts from here next time
    lastRepliedAt.set(roomId, body.id);
    // Also update high water
    highWater.set(roomId, Math.max(highWater.get(roomId) ?? 0, body.id));

    return { content: [{ type: 'text', text: `Message sent to ${roomId} (id: ${body.id})` }] };
  } catch (err) {
    log(`Reply ERROR: ${err.message}`);
    return { content: [{ type: 'text', text: `Reply error: ${err.message}` }], isError: true };
  }
}

// ── Connect stdio transport FIRST (before any I/O) ─────────────────────────

log('Connecting stdio transport...');
const transport = new StdioServerTransport();
await server.connect(transport);
log('Stdio transport connected');

// ── Polling loop — notification only ────────────────────────────────────────

async function discoverRooms() {
  const url = `${SERVER_URL}/rooms?member=${encodeURIComponent(AGENT_NAME)}`;
  log(`Discovering rooms: GET ${url}`);
  try {
    const res = await fetch(url, { headers: authHeaders, signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      log(`Room discovery FAILED: HTTP ${res.status}`);
      return;
    }
    const rooms = await res.json();
    const ids = rooms.map((r) => r.id);
    if (ids.length !== knownRooms.length || ids.some((id, i) => id !== knownRooms[i])) {
      log(`Rooms changed: [${knownRooms.join(', ')}] → [${ids.join(', ')}]`);
    }
    knownRooms = ids;
    log(`Known rooms (${knownRooms.length}): ${knownRooms.join(', ') || '(none)'}`);
  } catch (err) {
    log(`Room discovery ERROR: ${err.message}`);
  }
}

async function pollRoom(roomId) {
  const since = highWater.get(roomId) ?? 0;
  try {
    const res = await fetch(
      `${SERVER_URL}/rooms/${encodeURIComponent(roomId)}/messages?since=${since}&limit=50`,
      { headers: authHeaders, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) {
      log(`Poll ${roomId} FAILED: HTTP ${res.status}`);
      return;
    }
    const messages = await res.json();

    // Count new messages from others
    let newFromOthers = 0;
    for (const msg of messages) {
      highWater.set(roomId, Math.max(highWater.get(roomId) ?? 0, msg.id));
      if (msg.sender !== AGENT_NAME) {
        newFromOthers++;
      }
    }

    if (newFromOthers === 0) {
      log(`Poll ${roomId} (since=${since}): no new messages from others`);
      return;
    }

    // Accumulate unread count
    const prev = unreadCount.get(roomId) ?? 0;
    unreadCount.set(roomId, prev + newFromOthers);
    const total = unreadCount.get(roomId);

    log(`Poll ${roomId}: ${newFromOthers} new, ${total} total unread — sending notification`);

    // Send a single notification: "you have unread messages"
    try {
      await server.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `You have ${total} unread message(s) in room "${roomId}". Use the \`check_messages\` tool to read them.`,
          meta: {
            room: roomId,
            unread_count: String(total),
          },
        },
      });
      log(`Notification sent OK: ${total} unread in ${roomId}`);
    } catch (err) {
      log(`Notification FAILED: ${err.message}`);
    }
  } catch (err) {
    log(`Poll ${roomId} ERROR: ${err.message}`);
  }
}

async function poll() {
  log(`--- poll cycle ${pollCycle} ---`);
  if (pollCycle % DISCOVERY_EVERY_N === 0) {
    await discoverRooms();
  }
  pollCycle++;

  if (knownRooms.length === 0) {
    log('No rooms known — nothing to poll');
  }
  for (const roomId of knownRooms) {
    await pollRoom(roomId);
  }
}

log('Starting initial poll...');
poll();
setInterval(poll, POLL_INTERVAL_MS);
log('Poll loop scheduled');
