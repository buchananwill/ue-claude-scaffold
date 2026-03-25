import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from 'node:http';

const SERVER_URL = process.env.SERVER_URL ?? 'http://host.docker.internal:9100';
const AGENT_NAME = process.env.AGENT_NAME ?? 'unknown';
const SESSION_TOKEN = process.env.SESSION_TOKEN ?? '';

const authHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  'X-Agent-Name': AGENT_NAME,
  ...(SESSION_TOKEN ? { Authorization: `Bearer ${SESSION_TOKEN}` } : {}),
};

const server = new Server(
  { name: 'chat-channel', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {}
    },
    instructions: [
      'Chat room messages arrive as <channel> events.',
      'The "sender" attribute identifies who sent the message (an agent name or "user").',
      'The "room" attribute is the room ID. "message_id" is the message sequence number.',
      `Your agent name is "${AGENT_NAME}". Reply with the reply tool, passing the room ID from the event.`,
    ].join(' '),
  }
);

// Tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Send a message to a chat room',
    inputSchema: {
      type: 'object' as const,
      properties: {
        room: { type: 'string', description: 'Room ID to post to' },
        content: { type: 'string', description: 'Message content (markdown)' },
        replyTo: { type: 'number', description: 'Optional message ID to reply to' }
      },
      required: ['room', 'content']
    }
  }]
}));

// Tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'reply') {
    return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
  }
  const { room, content, replyTo } = request.params.arguments as { room: string; content: string; replyTo?: number };
  const res = await fetch(`${SERVER_URL}/rooms/${encodeURIComponent(room)}/messages`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ content, replyTo: replyTo ?? null })
  });
  const body = await res.json();
  if (!res.ok) {
    return { content: [{ type: 'text', text: `Failed to send: ${JSON.stringify(body)}` }], isError: true };
  }
  return { content: [{ type: 'text', text: `Message sent to ${room} (id: ${body.id})` }] };
});

// HTTP listener for push notifications from coordination server
const httpServer = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    const { roomId, message, roomMeta } = payload;

    // Build meta attributes — Claude Code wraps content in <channel> automatically
    const meta: Record<string, string> = {
      room: roomId,
      sender: message.sender,
      message_id: String(message.id),
    };
    if (roomMeta.unread > 1) meta.unread = String(roomMeta.unread);
    if (message.replyTo) meta.reply_to = String(message.replyTo);

    await server.notification({
      method: 'notifications/claude/channel',
      params: { content: message.content, meta }
    });

    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error('[chat-channel] Push error:', err);
    res.writeHead(500).end(JSON.stringify({ error: String(err) }));
  }
});

httpServer.listen(8788, '0.0.0.0', () => {
  console.error('[chat-channel] HTTP listener on port 8788');
});

// Connect MCP server via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
