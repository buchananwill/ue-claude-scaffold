import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db.js';

const roomsPlugin: FastifyPluginAsync = async (fastify) => {
  const insertRoom = db.prepare(
    'INSERT INTO rooms (id, name, type, created_by) VALUES (@id, @name, @type, @createdBy)'
  );

  const insertMember = db.prepare(
    'INSERT OR IGNORE INTO room_members (room_id, member) VALUES (@roomId, @member)'
  );

  const roomById = db.prepare('SELECT * FROM rooms WHERE id = @id');

  const roomMembers = db.prepare(
    'SELECT member, joined_at FROM room_members WHERE room_id = @roomId'
  );

  const deleteRoom = db.prepare('DELETE FROM rooms WHERE id = @id');

  const removeMember = db.prepare(
    'DELETE FROM room_members WHERE room_id = @roomId AND member = @member'
  );

  const insertChatMessage = db.prepare(
    'INSERT INTO chat_messages (room_id, sender, content, reply_to) VALUES (@roomId, @sender, @content, @replyTo)'
  );

  const isMember = db.prepare(
    'SELECT 1 FROM room_members WHERE room_id = @roomId AND member = @member'
  );

  const membersWithHost = db.prepare(`
    SELECT rm.member, a.container_host
    FROM room_members rm
    LEFT JOIN agents a ON a.name = rm.member
    WHERE rm.room_id = @roomId AND rm.member != @sender
  `);

  const unreadForMember = db.prepare(`
    SELECT COUNT(*) as unread
    FROM chat_messages
    WHERE room_id = @roomId
      AND id > COALESCE(
        (SELECT MAX(id) FROM chat_messages WHERE room_id = @roomId AND sender = @member),
        0
      )
  `);

  const agentByToken = db.prepare(
    'SELECT name FROM agents WHERE session_token = @token LIMIT 1'
  );

  // POST /rooms — create a room
  fastify.post<{
    Body: { id: string; name: string; type: 'group' | 'direct'; members?: string[] };
  }>('/rooms', async (request, reply) => {
    const caller = (request.headers['x-agent-name'] as string | undefined) ?? 'user';
    const { id, name, type, members } = request.body;

    if (type !== 'group' && type !== 'direct') {
      return reply.badRequest('type must be "group" or "direct"');
    }

    db.transaction(() => {
      insertRoom.run({ id, name, type, createdBy: caller });
      insertMember.run({ roomId: id, member: caller });
      if (members) {
        for (const m of members) {
          insertMember.run({ roomId: id, member: m });
        }
      }
    })();

    return { ok: true, id };
  });

  // GET /rooms — list rooms, optionally filtered by member
  fastify.get<{
    Querystring: { member?: string };
  }>('/rooms', async (request) => {
    let sql = 'SELECT r.*, (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) as member_count FROM rooms r';
    const params: unknown[] = [];

    if (request.query.member) {
      sql += ' WHERE r.id IN (SELECT room_id FROM room_members WHERE member = ?)';
      params.push(request.query.member);
    }

    const rows = db.prepare(sql).all(...params) as Array<{
      id: string; name: string; type: string; created_by: string; created_at: string; member_count: number;
    }>;

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      createdBy: r.created_by,
      createdAt: r.created_at,
      memberCount: r.member_count,
    }));
  });

  // GET /rooms/:id — get room details with members
  fastify.get<{
    Params: { id: string };
  }>('/rooms/:id', async (request, reply) => {
    const room = roomById.get({ id: request.params.id }) as {
      id: string; name: string; type: string; created_by: string; created_at: string;
    } | undefined;

    if (!room) {
      return reply.notFound(`Room '${request.params.id}' not found`);
    }

    const members = roomMembers.all({ roomId: room.id }) as Array<{ member: string; joined_at: string }>;

    return {
      id: room.id,
      name: room.name,
      type: room.type,
      createdBy: room.created_by,
      createdAt: room.created_at,
      members: members.map(m => ({ member: m.member, joinedAt: m.joined_at })),
    };
  });

  // DELETE /rooms/:id — delete a room
  fastify.delete<{
    Params: { id: string };
  }>('/rooms/:id', async (request, reply) => {
    const room = roomById.get({ id: request.params.id });
    if (!room) {
      return reply.notFound(`Room '${request.params.id}' not found`);
    }
    deleteRoom.run({ id: request.params.id });
    return { ok: true };
  });

  // POST /rooms/:id/members — add members to a room
  fastify.post<{
    Params: { id: string };
    Body: { members: string[] };
  }>('/rooms/:id/members', async (request, reply) => {
    const room = roomById.get({ id: request.params.id });
    if (!room) {
      return reply.notFound(`Room '${request.params.id}' not found`);
    }

    db.transaction(() => {
      for (const m of request.body.members) {
        insertMember.run({ roomId: request.params.id, member: m });
      }
    })();

    return { ok: true };
  });

  // DELETE /rooms/:id/members/:member — remove a member from a room
  fastify.delete<{
    Params: { id: string; member: string };
  }>('/rooms/:id/members/:member', async (request, reply) => {
    const room = roomById.get({ id: request.params.id });
    if (!room) {
      return reply.notFound(`Room '${request.params.id}' not found`);
    }
    removeMember.run({ roomId: request.params.id, member: request.params.member });
    return { ok: true };
  });

  // POST /rooms/:id/messages — send a chat message
  fastify.post<{
    Params: { id: string };
    Body: { content: string; replyTo?: number };
  }>('/rooms/:id/messages', async (request, reply) => {
    let sender = request.headers['x-agent-name'] as string | undefined;
    if (!sender) {
      // Resolve sender from session token (Bearer or query param) when header is missing
      const auth = request.headers.authorization;
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : (request.query as Record<string, string>).token;
      if (token) {
        const match = agentByToken.get({ token }) as { name: string } | undefined;
        sender = match?.name;
      }
      sender ??= 'user';
    }
    const { id } = request.params;
    const { content, replyTo } = request.body;
    fastify.log.info({ sender, roomId: id }, 'room message POST');

    const room = roomById.get({ id });
    if (!room) {
      return reply.notFound(`Room '${id}' not found`);
    }

    const membership = isMember.get({ roomId: id, member: sender });
    if (!membership) {
      return reply.code(403).send({ error: 'not_a_member' });
    }

    const result = insertChatMessage.run({ roomId: id, sender, content, replyTo: replyTo ?? null });

    // Phase 5b: broadcast message to member containers (fire-and-forget)
    const msgId = Number(result.lastInsertRowid);
    const recipients = membersWithHost.all({ roomId: id, sender }) as Array<{ member: string; container_host: string | null }>;
    for (const recipient of recipients) {
      if (!recipient.container_host) continue;
      const unreadRow = unreadForMember.get({ roomId: id, member: recipient.member }) as { unread: number };
      fetch(`http://${recipient.container_host}:8788`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: id,
          message: {
            id: msgId,
            sender,
            content,
            replyTo: replyTo ?? null,
            createdAt: new Date().toISOString()
          },
          roomMeta: {
            unread: unreadRow.unread,
            lastMessageId: msgId,
            lastSender: sender
          }
        }),
        signal: AbortSignal.timeout(3000)
      }).catch(err => {
        fastify.log.warn({ err, recipient: recipient.member }, 'chat push failed');
      });
    }

    return { ok: true, id: msgId };
  });

  // GET /rooms/:id/messages — get chat messages
  fastify.get<{
    Params: { id: string };
    Querystring: { since?: string; before?: string; limit?: string };
  }>('/rooms/:id/messages', async (request, reply) => {
    const { id } = request.params;
    const { since, before, limit } = request.query;
    const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 500);

    const room = roomById.get({ id });
    if (!room) {
      return reply.notFound(`Room '${id}' not found`);
    }

    const caller = request.headers['x-agent-name'] as string | undefined;
    if (caller) {
      const membership = isMember.get({ roomId: id, member: caller });
      if (!membership) {
        return reply.code(403).send({ error: 'not_a_member' });
      }
    }

    type ChatRow = {
      id: number; room_id: string; sender: string; content: string; reply_to: number | null; created_at: string;
    };

    const format = (r: ChatRow) => ({
      id: r.id,
      roomId: r.room_id,
      sender: r.sender,
      content: r.content,
      replyTo: r.reply_to,
      createdAt: r.created_at,
    });

    if (since) {
      const sql = 'SELECT * FROM chat_messages WHERE room_id = ? AND id > ? ORDER BY id ASC LIMIT ?';
      const rows = db.prepare(sql).all(id, Number(since), pageSize) as ChatRow[];
      return rows.map(format);
    }

    if (before) {
      const sql = 'SELECT * FROM chat_messages WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT ?';
      const rows = db.prepare(sql).all(id, Number(before), pageSize) as ChatRow[];
      rows.reverse();
      return rows.map(format);
    }

    const sql = 'SELECT * FROM chat_messages WHERE room_id = ? ORDER BY id DESC LIMIT ?';
    const rows = db.prepare(sql).all(id, pageSize) as ChatRow[];
    rows.reverse();
    return rows.map(format);
  });
};

export default roomsPlugin;
