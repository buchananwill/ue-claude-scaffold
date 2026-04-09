import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as roomsQ from '../queries/rooms.js';
import * as chatQ from '../queries/chat.js';
import * as agentsQ from '../queries/agents.js';
import { sql, eq } from 'drizzle-orm';
import { rooms, roomMembers, chatMessages, agents } from '../schema/tables.js';

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

    // Get join dates with agent names
    const memberRows = await db.select({
      agentId: roomMembers.agentId,
      joinedAt: roomMembers.joinedAt,
      name: agents.name,
    }).from(roomMembers)
      .innerJoin(agents, eq(agents.id, roomMembers.agentId))
      .where(eq(roomMembers.roomId, room.id));

    return {
      id: room.id,
      name: room.name,
      type: room.type,
      createdBy: room.createdBy,
      createdAt: room.createdAt,
      members: memberRows.map(m => ({ member: m.name, joinedAt: m.joinedAt })),
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

    for (const name of request.body.members) {
      const agent = await agentsQ.getByName(db, request.projectId, name);
      if (!agent) {
        return reply.code(404).send({ error: 'unknown_agent' });
      }
      await roomsQ.addMember(db, request.params.id, agent.id);
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
    const agent = await agentsQ.getByName(db, request.projectId, request.params.member);
    if (!agent) {
      return reply.code(404).send({ error: 'unknown_agent' });
    }
    await roomsQ.removeMember(db, request.params.id, agent.id);
    return { ok: true };
  });

  // POST /rooms/:id/messages — send a chat message
  fastify.post<{
    Params: { id: string };
    Body: { content: string; replyTo?: number };
  }>('/rooms/:id/messages', async (request, reply) => {
    const agentName = request.headers['x-agent-name'] as string | undefined;
    const db = getDb();
    const { id } = request.params;
    const { content, replyTo } = request.body;

    const room = await roomsQ.getRoom(db, id);
    if (!room) {
      return reply.notFound(`Room '${id}' not found`);
    }

    if (agentName) {
      // Agent flow: resolve agent, check membership
      const agent = await agentsQ.getByName(db, request.projectId, agentName);
      if (!agent) {
        return reply.code(403).send({ error: 'unknown_agent' });
      }
      const isMember = await chatQ.isAgentMember(db, id, agent.id);
      if (!isMember) {
        return reply.code(403).send({ error: 'not_a_member' });
      }
      fastify.log.info({ sender: agentName, roomId: id }, 'room message POST');
      const msg = await chatQ.sendMessage(db, { roomId: id, authorType: 'agent', authorAgentId: agent.id, content, replyTo: replyTo ?? null });
      return { ok: true, id: msg.id };
    }

    // Operator flow: skip membership check
    fastify.log.info({ sender: 'operator', roomId: id }, 'room message POST');
    const msg = await chatQ.sendMessage(db, { roomId: id, authorType: 'operator', authorAgentId: null, content, replyTo: replyTo ?? null });
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

    const callerName = request.headers['x-agent-name'] as string | undefined;
    if (callerName) {
      const agent = await agentsQ.getByName(db, request.projectId, callerName);
      if (!agent) {
        return reply.code(403).send({ error: 'unknown_agent' });
      }
      const isMember = await chatQ.isAgentMember(db, id, agent.id);
      if (!isMember) {
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

    // Use raw SQL for the transcript query since it joins rooms + chat_messages + agents with formatting
    const roomFilter = request.query.room;
    const rows = roomFilter
      ? await db.execute(sql`
          SELECT
            ${rooms.name} AS room_name,
            ${chatMessages.roomId} AS "roomId",
            COALESCE(
              ${agents.name},
              CASE ${chatMessages.authorType} WHEN 'operator' THEN 'user' WHEN 'system' THEN 'system' END
            ) AS sender,
            ${chatMessages.content},
            to_char(${chatMessages.createdAt}, 'MM-DD HH24:MI') AS time
          FROM ${chatMessages}
          LEFT JOIN ${agents} ON ${agents.id} = ${chatMessages.authorAgentId}
          INNER JOIN ${rooms} ON ${rooms.id} = ${chatMessages.roomId}
          WHERE ${chatMessages.roomId} = ${roomFilter}
          ORDER BY ${chatMessages.createdAt}
        `)
      : await db.execute(sql`
          SELECT
            ${rooms.name} AS room_name,
            ${chatMessages.roomId} AS "roomId",
            COALESCE(
              ${agents.name},
              CASE ${chatMessages.authorType} WHEN 'operator' THEN 'user' WHEN 'system' THEN 'system' END
            ) AS sender,
            ${chatMessages.content},
            to_char(${chatMessages.createdAt}, 'MM-DD HH24:MI') AS time
          FROM ${chatMessages}
          LEFT JOIN ${agents} ON ${agents.id} = ${chatMessages.authorAgentId}
          INNER JOIN ${rooms} ON ${rooms.id} = ${chatMessages.roomId}
          ORDER BY ${chatMessages.roomId}, ${chatMessages.createdAt}
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
