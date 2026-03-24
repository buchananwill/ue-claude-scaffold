import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from 'node:http';

const SERVER_URL = process.env.SERVER_URL ?? 'http://host.docker.internal:9100';
const AGENT_NAME = process.env.AGENT_NAME ?? 'unknown';

const server = new Server(
  { name: 'chat-channel', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {}
    }
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
    headers: { 'Content-Type': 'application/json', 'X-Agent-Name': AGENT_NAME },
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

    // Build channel content string
    const unreadNote = roomMeta.unread > 1 ? ` unread="${roomMeta.unread}"` : '';
    const replyNote = message.replyTo ? ` reply_to="${message.replyTo}"` : '';
    const content = `<channel source="chat" room="${roomId}" sender="${message.sender}" message_id="${message.id}"${unreadNote}${replyNote}>\n${message.content}\n</channel>`;

    await server.notification({
      method: 'notifications/claude/channel',
      params: { content, meta: { room: roomId, sender: message.sender, message_id: String(message.id) } }
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
