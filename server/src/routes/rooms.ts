import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as roomsQ from '../queries/rooms.js';
import * as chatQ from '../queries/chat.js';
import * as agentsQ from '../queries/agents.js';
import { sql, eq } from 'drizzle-orm';
import { rooms, roomMembers, chatMessages, agents } from '../schema/tables.js';

const ROOM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Parse a cursor query parameter for message pagination.
 * Returns `undefined` if absent, `NaN` if present but invalid,
 * or a non-negative safe integer otherwise.
 */
function parseMessageCursor(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
    return NaN; // sentinel — caller checks with Number.isNaN
  }
  return n;
}

/** Route-level guard: verify the room belongs to the requesting project. */
function assertProjectMatch(
  room: { projectId: string },
  requestProjectId: string,
  reply: FastifyReply,
): boolean {
  if (room.projectId !== requestProjectId) {
    reply.code(404).send({ error: 'not_found' });
    return false;
  }
  return true;
}

const roomsPlugin: FastifyPluginAsync = async (fastify) => {
  // POST /rooms — create a room
  fastify.post<{
    Body: { id: string; name: string; type: 'group' | 'direct'; members?: string[] };
  }>('/rooms', async (request, reply) => {
    const agentName = request.headers['x-agent-name'] as string | undefined;
    const caller = agentName ?? 'operator';
    const { id, name, type, members } = request.body;
    const db = getDb();

    // Validate id and name
    if (!id || !ROOM_ID_RE.test(id)) {
      return reply.badRequest('id must match /^[a-zA-Z0-9_-]{1,64}$/');
    }
    if (!name || name.trim().length === 0 || name.length > 256) {
      return reply.badRequest('name is required and must be at most 256 characters');
    }

    if (type !== 'group' && type !== 'direct') {
      return reply.badRequest('type must be "group" or "direct"');
    }

    // Resolve caller agent UUID before creating room
    let callerAgentId: string | undefined;
    if (agentName) {
      const callerAgent = await agentsQ.getByName(db, request.projectId, agentName);
      if (!callerAgent) {
        return reply.code(403).send({ error: 'unknown_agent' });
      }
      callerAgentId = callerAgent.id;
    }

    // Resolve all member names to UUIDs before creating room
    const memberIds: string[] = [];
    if (members) {
      for (const m of members) {
        const agent = await agentsQ.getByName(db, request.projectId, m);
        if (!agent) {
          return reply.notFound(`Unknown agent: ${m}`);
        }
        memberIds.push(agent.id);
      }
    }

    // Now create the room and add members
    await roomsQ.createRoom(db, { id, name, type, createdBy: caller, projectId: request.projectId });

    if (callerAgentId) {
      await roomsQ.addMember(db, id, callerAgentId);
    }

    for (const mid of memberIds) {
      await roomsQ.addMember(db, id, mid);
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
    return Promise.all(rows.map(async (r) => {
      const members = await roomsQ.getMembers(db, r.id);
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
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
    if (!assertProjectMatch(room, request.projectId, reply)) return;

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
    if (!assertProjectMatch(room, request.projectId, reply)) return;

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
    if (!assertProjectMatch(room, request.projectId, reply)) return;
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
    if (!assertProjectMatch(room, request.projectId, reply)) return;

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
    if (!assertProjectMatch(room, request.projectId, reply)) return;
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
    if (!assertProjectMatch(room, request.projectId, reply)) return;

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

    // Validate cursors before any DB access
    const sinceN = parseMessageCursor(since);
    const beforeN = parseMessageCursor(before);
    if (Number.isNaN(sinceN)) {
      return reply.badRequest('since must be a non-negative safe integer');
    }
    if (Number.isNaN(beforeN)) {
      return reply.badRequest('before must be a non-negative safe integer');
    }

    const db = getDb();

    const room = await roomsQ.getRoom(db, id);
    if (!room) {
      return reply.notFound(`Room '${id}' not found`);
    }
    if (!assertProjectMatch(room, request.projectId, reply)) return;

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
      after: sinceN,
      before: beforeN,
      limit: pageSize,
    });

    return rows.map((r) => ({
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
    if (roomFilter && !ROOM_ID_RE.test(roomFilter)) {
      return reply.badRequest('Invalid room filter');
    }
    const rows = roomFilter
      ? await db.execute(sql`
          SELECT
            ${rooms.name} AS room_name,
            ${chatMessages.roomId} AS "roomId",
            COALESCE(
              ${agents.name},
              CASE ${chatMessages.authorType} WHEN 'operator' THEN 'operator' WHEN 'system' THEN 'system' ELSE 'unknown' END
            ) AS sender,
            ${chatMessages.content},
            to_char(${chatMessages.createdAt}, 'MM-DD HH24:MI') AS time
          FROM ${chatMessages}
          LEFT JOIN ${agents} ON ${agents.id} = ${chatMessages.authorAgentId}
          INNER JOIN ${rooms} ON ${rooms.id} = ${chatMessages.roomId}
          WHERE ${chatMessages.roomId} = ${roomFilter}
            AND ${rooms.projectId} = ${request.projectId}
          ORDER BY ${chatMessages.createdAt}
        `)
      : await db.execute(sql`
          SELECT
            ${rooms.name} AS room_name,
            ${chatMessages.roomId} AS "roomId",
            COALESCE(
              ${agents.name},
              CASE ${chatMessages.authorType} WHEN 'operator' THEN 'operator' WHEN 'system' THEN 'system' ELSE 'unknown' END
            ) AS sender,
            ${chatMessages.content},
            to_char(${chatMessages.createdAt}, 'MM-DD HH24:MI') AS time
          FROM ${chatMessages}
          LEFT JOIN ${agents} ON ${agents.id} = ${chatMessages.authorAgentId}
          INNER JOIN ${rooms} ON ${rooms.id} = ${chatMessages.roomId}
          WHERE ${rooms.projectId} = ${request.projectId}
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
