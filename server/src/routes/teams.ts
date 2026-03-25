import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db.js';

const VALID_STATUSES = ['active', 'converging', 'dissolved'] as const;

const teamsPlugin: FastifyPluginAsync = async (fastify) => {
  const insertTeam = db.prepare(
    'INSERT INTO teams (id, name, brief_path) VALUES (@id, @name, @briefPath)'
  );

  const insertTeamMember = db.prepare(
    'INSERT INTO team_members (team_id, agent_name, role, is_chairman) VALUES (@teamId, @agentName, @role, @isChairman)'
  );

  const insertRoom = db.prepare(
    'INSERT INTO rooms (id, name, type, created_by) VALUES (@id, @name, @type, @createdBy)'
  );

  const insertRoomMember = db.prepare(
    'INSERT OR IGNORE INTO room_members (room_id, member) VALUES (@roomId, @member)'
  );

  const deleteRoomMembersByRoom = db.prepare('DELETE FROM room_members WHERE room_id = @roomId');
  const deleteRoomById = db.prepare('DELETE FROM rooms WHERE id = @id');
  const deleteTeamMembersByTeam = db.prepare('DELETE FROM team_members WHERE team_id = @teamId');
  const deleteTeamById = db.prepare('DELETE FROM teams WHERE id = @id');

  const teamById = db.prepare('SELECT * FROM teams WHERE id = @id');

  const teamMembersByTeamId = db.prepare(
    'SELECT agent_name, role, is_chairman FROM team_members WHERE team_id = @teamId'
  );

  const dissolveTeam = db.prepare(
    "UPDATE teams SET status = 'dissolved', dissolved_at = datetime('now') WHERE id = @id"
  );

  const updateTeamStatus = db.prepare(
    'UPDATE teams SET status = @status WHERE id = @id'
  );

  const updateTeamDeliverable = db.prepare(
    'UPDATE teams SET deliverable = @deliverable WHERE id = @id'
  );

  // POST /teams — create a team
  fastify.post<{
    Body: {
      id: string;
      name: string;
      briefPath?: string;
      members: Array<{ agentName: string; role: string; isChairman?: boolean }>;
    };
  }>('/teams', async (request, reply) => {
    const caller = (request.headers['x-agent-name'] as string | undefined) ?? 'user';
    const { id, name, briefPath, members } = request.body;

    const chairmanCount = members.filter(m => m.isChairman).length;
    if (chairmanCount !== 1) {
      return reply.badRequest('Exactly one chairman is required');
    }

    try {
      db.transaction(() => {
        const existing = teamById.get({ id }) as { status: string } | undefined;
        if (existing) {
          if (existing.status !== 'dissolved') {
            throw Object.assign(new Error(`Team '${id}' already exists and is not dissolved`), { statusCode: 409 });
          }
          deleteRoomMembersByRoom.run({ roomId: id });
          deleteRoomById.run({ id });
          deleteTeamMembersByTeam.run({ teamId: id });
          deleteTeamById.run({ id });
        }

        insertTeam.run({ id, name, briefPath: briefPath ?? null });
        for (const m of members) {
          insertTeamMember.run({
            teamId: id,
            agentName: m.agentName,
            role: m.role,
            isChairman: m.isChairman ? 1 : 0,
          });
        }
        insertRoom.run({ id, name, type: 'group', createdBy: caller });
        for (const m of members) {
          insertRoomMember.run({ roomId: id, member: m.agentName });
        }
        insertRoomMember.run({ roomId: id, member: 'user' });
      })();
    } catch (err: unknown) {
      if (err instanceof Error && (err as Error & { statusCode?: number }).statusCode === 409) {
        return reply.status(409).send({ error: err.message });
      }
      throw err;
    }

    return { ok: true, id, roomId: id };
  });

  // GET /teams — list teams
  fastify.get<{
    Querystring: { status?: string };
  }>('/teams', async (request) => {
    let sql = 'SELECT * FROM teams';
    const params: unknown[] = [];

    if (request.query.status) {
      sql += ' WHERE status = ?';
      params.push(request.query.status);
    }

    type TeamRow = {
      id: string; name: string; brief_path: string | null; status: string;
      deliverable: string | null; created_at: string; dissolved_at: string | null;
    };

    const rows = db.prepare(sql).all(...params) as TeamRow[];

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      briefPath: r.brief_path,
      status: r.status,
      deliverable: r.deliverable,
      createdAt: r.created_at,
      dissolvedAt: r.dissolved_at,
    }));
  });

  // GET /teams/:id — team detail with members
  fastify.get<{
    Params: { id: string };
  }>('/teams/:id', async (request, reply) => {
    const team = teamById.get({ id: request.params.id }) as {
      id: string; name: string; brief_path: string | null; status: string;
      deliverable: string | null; created_at: string; dissolved_at: string | null;
    } | undefined;

    if (!team) {
      return reply.notFound(`Team '${request.params.id}' not found`);
    }

    const members = teamMembersByTeamId.all({ teamId: team.id }) as Array<{
      agent_name: string; role: string; is_chairman: number;
    }>;

    return {
      id: team.id,
      name: team.name,
      briefPath: team.brief_path,
      status: team.status,
      deliverable: team.deliverable,
      createdAt: team.created_at,
      dissolvedAt: team.dissolved_at,
      roomId: team.id,
      members: members.map(m => ({
        agentName: m.agent_name,
        role: m.role,
        isChairman: m.is_chairman === 1,
      })),
    };
  });

  // DELETE /teams/:id — soft delete (dissolve)
  fastify.delete<{
    Params: { id: string };
  }>('/teams/:id', async (request, reply) => {
    const team = teamById.get({ id: request.params.id });
    if (!team) {
      return reply.notFound(`Team '${request.params.id}' not found`);
    }
    dissolveTeam.run({ id: request.params.id });
    return { ok: true };
  });

  // PATCH /teams/:id — update status and/or deliverable
  fastify.patch<{
    Params: { id: string };
    Body: { status?: string; deliverable?: string };
  }>('/teams/:id', async (request, reply) => {
    const team = teamById.get({ id: request.params.id });
    if (!team) {
      return reply.notFound(`Team '${request.params.id}' not found`);
    }

    const { status, deliverable } = request.body;

    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
        return reply.badRequest(`Invalid status '${status}'. Must be one of: ${VALID_STATUSES.join(', ')}`);
      }
    }

    db.transaction(() => {
      if (status !== undefined) {
        if (status === 'dissolved') {
          dissolveTeam.run({ id: request.params.id });
        } else {
          updateTeamStatus.run({ id: request.params.id, status });
        }
      }

      if (deliverable !== undefined) {
        updateTeamDeliverable.run({ id: request.params.id, deliverable });
      }
    })();

    return { ok: true };
  });
};

export default teamsPlugin;
