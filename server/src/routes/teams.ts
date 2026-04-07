import type { FastifyPluginAsync } from 'fastify';
import type { ScaffoldConfig } from '../config.js';
import { getDb } from '../drizzle-instance.js';
import { resolveProject } from '../resolve-project.js';
import { launchTeam } from '../team-launcher.js';
import * as teamsQ from '../queries/teams.js';
import * as roomsQ from '../queries/rooms.js';

const VALID_STATUSES = ['active', 'converging', 'dissolved'] as const;

interface TeamsPluginOpts {
  config?: ScaffoldConfig;
}

const teamsPlugin: FastifyPluginAsync<TeamsPluginOpts> = async (fastify, opts) => {
  const config = opts.config;
  // POST /teams — create a team
  fastify.post<{
    Body: {
      id: string;
      name: string;
      briefPath?: string;
      members: Array<{ agentName: string; role: string; isLeader?: boolean }>;
    };
  }>('/teams', async (request, reply) => {
    const caller = (request.headers['x-agent-name'] as string | undefined) ?? 'user';
    const { id, name, briefPath, members } = request.body;
    const db = getDb();

    const leaderCount = members.filter(m => m.isLeader).length;
    if (leaderCount !== 1) {
      return reply.badRequest('Exactly one discussion leader is required');
    }

    try {
      await db.transaction(async (tx) => {
        const existing = await teamsQ.getById(tx as any, id);
        if (existing) {
          if (existing.status !== 'dissolved') {
            throw Object.assign(new Error(`Team '${id}' already exists and is not dissolved`), { statusCode: 409 });
          }
          // Clean up old team data
          await roomsQ.deleteRoom(tx as any, id);
          await teamsQ.deleteTeam(tx as any, id);
        }

        await teamsQ.create(tx as any, { id, name, briefPath: briefPath ?? null, projectId: request.projectId });
        for (const m of members) {
          await teamsQ.addMember(tx as any, id, m.agentName, m.role, m.isLeader);
        }
        await roomsQ.createRoom(tx as any, { id, name, type: 'group', createdBy: caller, projectId: request.projectId });
        for (const m of members) {
          await roomsQ.addMember(tx as any, id, m.agentName);
        }
        await roomsQ.addMember(tx as any, id, 'user');
      });
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
    const db = getDb();
    const rows = await teamsQ.list(db, { status: request.query.status || undefined, projectId: request.projectId });

    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      briefPath: r.briefPath,
      status: r.status,
      deliverable: r.deliverable,
      createdAt: r.createdAt,
      dissolvedAt: r.dissolvedAt,
    }));
  });

  // GET /teams/:id — team detail with members
  fastify.get<{
    Params: { id: string };
  }>('/teams/:id', async (request, reply) => {
    const db = getDb();
    const team = await teamsQ.getById(db, request.params.id);
    if (!team) {
      return reply.notFound(`Team '${request.params.id}' not found`);
    }

    const members = await teamsQ.getMembers(db, team.id);

    return {
      id: team.id,
      name: team.name,
      briefPath: team.briefPath,
      status: team.status,
      deliverable: team.deliverable,
      createdAt: team.createdAt,
      dissolvedAt: team.dissolvedAt,
      roomId: team.id,
      members: members.map(m => ({
        agentName: m.agentName,
        role: m.role,
        isLeader: m.isLeader,
      })),
    };
  });

  // DELETE /teams/:id — soft delete (dissolve)
  fastify.delete<{
    Params: { id: string };
  }>('/teams/:id', async (request, reply) => {
    const db = getDb();
    const team = await teamsQ.getById(db, request.params.id);
    if (!team) {
      return reply.notFound(`Team '${request.params.id}' not found`);
    }
    await teamsQ.dissolve(db, request.params.id);
    return { ok: true };
  });

  // PATCH /teams/:id — update status and/or deliverable
  fastify.patch<{
    Params: { id: string };
    Body: { status?: string; deliverable?: string };
  }>('/teams/:id', async (request, reply) => {
    const db = getDb();
    const team = await teamsQ.getById(db, request.params.id);
    if (!team) {
      return reply.notFound(`Team '${request.params.id}' not found`);
    }

    const { status, deliverable } = request.body;

    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
        return reply.badRequest(`Invalid status '${status}'. Must be one of: ${VALID_STATUSES.join(', ')}`);
      }
    }

    if (status !== undefined) {
      if (status === 'dissolved') {
        await teamsQ.dissolve(db, request.params.id);
      } else {
        await teamsQ.updateStatus(db, request.params.id, status);
      }
    }

    if (deliverable !== undefined) {
      await teamsQ.updateDeliverable(db, request.params.id, deliverable);
    }

    return { ok: true };
  });
  // POST /teams/:id/launch — server-side team launch
  fastify.post<{
    Params: { id: string };
    Body: { projectId?: string; briefPath: string; teamsDir?: string };
  }>('/teams/:id/launch', async (request, reply) => {
    if (!config) {
      return reply.code(500).send({ error: 'Server config not available for team launch' });
    }

    const teamId = request.params.id;
    const { briefPath, teamsDir } = request.body;
    const projectId = request.body.projectId ?? request.projectId;
    const db = getDb();

    if (!briefPath) {
      return reply.badRequest('briefPath is required');
    }

    let project;
    try {
      project = await resolveProject(config, db, projectId);
    } catch {
      return reply.badRequest(`Unknown project: "${projectId}"`);
    }

    // Default teamsDir to a sibling 'teams/' directory relative to config location
    // In practice, the shell caller will pass the correct teamsDir
    const resolvedTeamsDir = teamsDir ?? '';
    if (!resolvedTeamsDir) {
      return reply.badRequest('teamsDir is required');
    }

    try {
      const result = await launchTeam({
        projectId,
        teamId,
        briefPath,
        teamsDir: resolvedTeamsDir,
        project,
        db,
      });
      return { ok: true, ...result };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Distinguish "not found" errors from other failures
      if (message.includes('not found')) {
        return reply.notFound(message);
      }
      return reply.badRequest(message);
    }
  });
};

export default teamsPlugin;
