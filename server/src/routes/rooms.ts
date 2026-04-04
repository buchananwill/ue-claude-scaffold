import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as roomsQ from '../queries/rooms.js';
import * as chatQ from '../queries/chat.js';
import * as agentsQ from '../queries/agents.js';
import { sql, count as countFn, eq } from 'drizzle-orm';
import { rooms, roomMembers, chatMessages } from '../schema/tables.js';

const roomsPlugin: FastifyPluginAsync = async (fastify) => {
  // POST /rooms — create a room
  fastify.post<{
    Body: { id: string; name: string; type: 'group' | 'direct'; members?: string[] };
  }>('/rooms', async (request, reply) => {
    const caller = (request.headers['x-agent-name'] as string | undefined) ?? 'user';
    const { id, name, type, members } = request.body;
    const db = getDb();

    if (type !== 'group' && type !== 'direct') {
      return reply.badRequest('type must be "group" or "direct"');
    }

    await roomsQ.createRoom(db, { id, name, type, createdBy: caller, projectId: request.projectId });
    await roomsQ.addMember(db, id, caller);
    if (members) {
      for (const m of members) {
        await roomsQ.addMember(db, id, m);
      }
    }

    return { ok: true, id };
  });

  // GET /rooms — list rooms, optionally filtered by member
  fastify.get<{
    Querystring: { member?: string };
  }>('/rooms', async (request) => {
    const db = getDb();
    const rows = await roomsQ.listRooms(db, { member: request.query.member, projectId: request.projectId });

    // Compute member counts
    return Promise.all(rows.map(async (r: any) => {
      const members = await roomsQ.getMembers(db, r.id);
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        createdBy: r.createdBy ?? r.created_by,
        createdAt: r.createdAt ?? r.created_at,
        memberCount: members.length,
      };
    }));
  });

  // GET /rooms/:id — get room details with members
  fastify.get<{
    Params: { id: string };
  }>('/rooms/:id', async (request, reply) => {
    const db = getDb();
    const room = await roomsQ.getRoom(db, request.params.id);
    if (!room) {
      return reply.notFound(`Room '${request.params.id}' not found`);
    }

    const members = await roomsQ.getMembers(db, room.id);
    // Get join dates
    const memberRows = await db.select().from(roomMembers).where(eq(roomMembers.roomId, room.id));

    return {
      id: room.id,
      name: room.name,
      type: room.type,
      createdBy: room.createdBy,
      createdAt: room.createdAt,
      members: memberRows.map(m => ({ member: m.member, joinedAt: m.joinedAt })),
    };
  });

  // GET /rooms/:id/presence — who is in the room and are they online?
  fastify.get<{
    Params: { id: string };
  }>('/rooms/:id/presence', async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const room = await roomsQ.getRoom(db, id);
    if (!room) {
      return reply.notFound(`Room '${id}' not found`);
    }

    const presenceRows = await roomsQ.getPresence(db, id);
    return {
      room: id,
      members: presenceRows,
    };
  });

  // DELETE /rooms/:id — delete a room
  fastify.delete<{
    Params: { id: string };
  }>('/rooms/:id', async (request, reply) => {
    const db = getDb();
    const room = await roomsQ.getRoom(db, request.params.id);
    if (!room) {
      return reply.notFound(`Room '${request.params.id}' not found`);
    }
    await roomsQ.deleteRoom(db, request.params.id);
    return { ok: true };
  });

  // POST /rooms/:id/members — add members to a room
  fastify.post<{
    Params: { id: string };
    Body: { members: string[] };
  }>('/rooms/:id/members', async (request, reply) => {
    const db = getDb();
    const room = await roomsQ.getRoom(db, request.params.id);
    if (!room) {
      return reply.notFound(`Room '${request.params.id}' not found`);
    }

    for (const m of request.body.members) {
      await roomsQ.addMember(db, request.params.id, m);
    }

    return { ok: true };
  });

  // DELETE /rooms/:id/members/:member — remove a member from a room
  fastify.delete<{
    Params: { id: string; member: string };
  }>('/rooms/:id/members/:member', async (request, reply) => {
    const db = getDb();
    const room = await roomsQ.getRoom(db, request.params.id);
    if (!room) {
      return reply.notFound(`Room '${request.params.id}' not found`);
    }
    await roomsQ.removeMember(db, request.params.id, request.params.member);
    return { ok: true };
  });

  // POST /rooms/:id/messages — send a chat message
  fastify.post<{
    Params: { id: string };
    Body: { content: string; replyTo?: number };
  }>('/rooms/:id/messages', async (request, reply) => {
    let sender = request.headers['x-agent-name'] as string | undefined;
    const db = getDb();

    if (!sender) {
      // Resolve sender from session token (Bearer or query param) when header is missing
      const auth = request.headers.authorization;
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : (request.query as Record<string, string>).token;
      if (token) {
        const match = await agentsQ.getByToken(db, token);
        sender = match?.name;
      }
      sender ??= 'user';
    }
    const { id } = request.params;
    const { content, replyTo } = request.body;
    fastify.log.info({ sender, roomId: id }, 'room message POST');

    const room = await roomsQ.getRoom(db, id);
    if (!room) {
      return reply.notFound(`Room '${id}' not found`);
    }

    const membership = await chatQ.isMember(db, id, sender);
    if (!membership) {
      return reply.code(403).send({ error: 'not_a_member' });
    }

    const msg = await chatQ.sendMessage(db, { roomId: id, sender, content, replyTo: replyTo ?? null });
    return { ok: true, id: msg.id };
  });

  // GET /rooms/:id/messages — get chat messages
  fastify.get<{
    Params: { id: string };
    Querystring: { since?: string; before?: string; limit?: string };
  }>('/rooms/:id/messages', async (request, reply) => {
    const { id } = request.params;
    const { since, before, limit } = request.query;
    const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const db = getDb();

    const room = await roomsQ.getRoom(db, id);
    if (!room) {
      return reply.notFound(`Room '${id}' not found`);
    }

    const caller = request.headers['x-agent-name'] as string | undefined;
    if (caller) {
      const membership = await chatQ.isMember(db, id, caller);
      if (!membership) {
        return reply.code(403).send({ error: 'not_a_member' });
      }
    }

    const rows = await chatQ.getHistory(db, id, {
      after: since ? Number(since) : undefined,
      before: before ? Number(before) : undefined,
      limit: pageSize,
    });

    return rows.map((r: any) => ({
      id: r.id,
      roomId: r.roomId,
      sender: r.sender,
      content: r.content,
      replyTo: r.replyTo,
      createdAt: r.createdAt,
    }));
  });

  // GET /transcript — readable chat transcript across all rooms (or one room)
  fastify.get<{
    Querystring: { room?: string };
  }>('/transcript', async (request, reply) => {
    const db = getDb();

    // Use raw SQL for the transcript query since it joins rooms + chat_messages with formatting
    const roomFilter = request.query.room;
    const rows = roomFilter
      ? await db.execute(sql`
          SELECT r.name AS room_name, cm.room_id AS "roomId", cm.sender, cm.content,
                 to_char(cm.created_at, 'MM-DD HH24:MI') AS time
          FROM chat_messages cm
          JOIN rooms r ON r.id = cm.room_id
          WHERE cm.room_id = ${roomFilter}
          ORDER BY cm.created_at
        `)
      : await db.execute(sql`
          SELECT r.name AS room_name, cm.room_id AS "roomId", cm.sender, cm.content,
                 to_char(cm.created_at, 'MM-DD HH24:MI') AS time
          FROM chat_messages cm
          JOIN rooms r ON r.id = cm.room_id
          ORDER BY cm.room_id, cm.created_at
        `);

    type Row = { room_name: string; roomId: string; sender: string; content: string; time: string };
    const typedRows = rows.rows as Row[];

    let text = '';
    let currentRoom = '';
    for (const r of typedRows) {
      if (r.roomId !== currentRoom) {
        text += `\n══════ ${r.room_name} ══════\n\n`;
        currentRoom = r.roomId;
      }
      text += `[${r.time}] ${r.sender}:\n${r.content}\n\n`;
    }

    reply.type('text/plain; charset=utf-8').send(text);
  });
};

export default roomsPlugin;
