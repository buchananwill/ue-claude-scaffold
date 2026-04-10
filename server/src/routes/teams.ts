import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { ScaffoldConfig } from '../config.js';
import { getDb } from '../drizzle-instance.js';
import { resolveProject } from '../resolve-project.js';
import { launchTeam } from '../team-launcher.js';
import { AGENT_NAME_RE } from '../branch-naming.js';
import * as teamsQ from '../queries/teams.js';
import * as roomsQ from '../queries/rooms.js';
import { resolveAgent } from './route-helpers.js';

const VALID_STATUSES = ['active', 'converging', 'dissolved'] as const;

/** Regex for safe briefPath values — no path traversal, no absolute paths. */
const BRIEF_PATH_RE = /^[a-zA-Z0-9_./-]+$/;

/** Regex for safe role values — alphanumeric, spaces, hyphens, underscores, 1-128 chars. */
const ROLE_RE = /^[a-zA-Z0-9 _-]{1,128}$/;

interface TeamsOpts {
  config: ScaffoldConfig;
}

const teamsPlugin: FastifyPluginAsync<TeamsOpts> = async (fastify, opts) => {
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

    // Validate team id format
    if (!AGENT_NAME_RE.test(id)) {
      return reply.badRequest('Invalid team id — must match ^[a-zA-Z0-9_-]{1,64}$');
    }

    // Validate briefPath if provided — no path traversal
    if (briefPath != null) {
      if (briefPath.startsWith('/')) {
        return reply.badRequest('briefPath must be a relative path');
      }
      const segments = briefPath.split('/');
      if (segments.some(s => s.startsWith('.'))) {
        return reply.badRequest('briefPath must not contain dot-prefixed segments');
      }
      if (!BRIEF_PATH_RE.test(briefPath)) {
        return reply.badRequest('briefPath contains invalid characters');
      }
    }

    // Validate each member's agentName and role
    for (const m of members) {
      const safeName = m.agentName.slice(0, 64);
      if (!AGENT_NAME_RE.test(m.agentName)) {
        return reply.badRequest(`Invalid agentName '${safeName}' — must match ^[a-zA-Z0-9_-]{1,64}$`);
      }
      if (!m.role || m.role.trim().length === 0) {
        return reply.badRequest(`Member '${safeName}' has an empty role`);
      }
      if (!ROLE_RE.test(m.role)) {
        return reply.badRequest(`Member '${safeName}' has an invalid role — must match ^[a-zA-Z0-9 _-]{1,128}$`);
      }
    }

    const leaderCount = members.filter(m => m.isLeader).length;
    if (leaderCount !== 1) {
      return reply.badRequest('Exactly one discussion leader is required');
    }

    // Resolve agent names to UUIDs
    const resolvedMembers: Array<{ agentId: string; role: string; isLeader?: boolean }> = [];
    for (const m of members) {
      const agentRow = await resolveAgent(db, request.projectId, m.agentName);
      if (!agentRow) {
        return reply.badRequest(`Agent '${m.agentName}' not found in project '${request.projectId}'`);
      }
      resolvedMembers.push({ agentId: agentRow.id, role: m.role, isLeader: m.isLeader });
    }

    try {
      await db.transaction(async (tx) => {
        const existing = await teamsQ.getById(tx, id, request.projectId);
        if (existing) {
          if (existing.status !== 'dissolved') {
            throw Object.assign(new Error(`Team '${id}' already exists and is not dissolved`), { statusCode: 409 });
          }
          // Clean up old team data
          await roomsQ.deleteRoom(tx, id, request.projectId);
          await teamsQ.deleteTeam(tx, id, request.projectId);
        }

        await teamsQ.createWithRoom(tx, {
          id,
          name,
          briefPath: briefPath ?? null,
          projectId: request.projectId,
          createdBy: caller,
          members: resolvedMembers,
        });
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
  }>('/teams', async (request, reply) => {
    const statusFilter = request.query.status || undefined;
    if (statusFilter !== undefined && !(VALID_STATUSES as readonly string[]).includes(statusFilter)) {
      return reply.badRequest(`Invalid status filter '${statusFilter}'. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }
    const db = getDb();
    const rows = await teamsQ.list(db, { status: statusFilter, projectId: request.projectId });

    return rows.map((r) => ({
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
    const team = await teamsQ.getById(db, request.params.id, request.projectId);
    if (!team) {
      return reply.notFound(`Team '${request.params.id}' not found`);
    }

    const members = await teamsQ.getMembers(db, team.id);

    return {
      id: team.id,
      projectId: team.projectId,
      name: team.name,
      briefPath: team.briefPath,
      status: team.status,
      deliverable: team.deliverable,
      createdAt: team.createdAt,
      dissolvedAt: team.dissolvedAt,
      roomId: team.id,
      members: members.map(m => ({
        agentId: m.agentId,
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
    const team = await teamsQ.getById(db, request.params.id, request.projectId);
    if (!team) {
      return reply.notFound(`Team '${request.params.id}' not found`);
    }
    await teamsQ.dissolve(db, request.params.id, request.projectId);
    return { ok: true };
  });

  // PATCH /teams/:id — update status and/or deliverable
  fastify.patch<{
    Params: { id: string };
    Body: { status?: string; deliverable?: string };
  }>('/teams/:id', async (request, reply) => {
    const db = getDb();
    const team = await teamsQ.getById(db, request.params.id, request.projectId);
    if (!team) {
      return reply.notFound(`Team '${request.params.id}' not found`);
    }

    const { status, deliverable } = request.body;

    if (status !== undefined) {
      if (!(VALID_STATUSES as readonly string[]).includes(status)) {
        return reply.badRequest(`Invalid status '${status}'. Must be one of: ${VALID_STATUSES.join(', ')}`);
      }
      if (status === 'dissolved') {
        await teamsQ.dissolve(db, request.params.id, request.projectId);
      } else {
        await teamsQ.updateStatus(db, request.params.id, request.projectId, status);
      }
    }

    if (deliverable !== undefined) {
      if (typeof deliverable !== 'string' || deliverable.length > 65536) {
        return reply.badRequest('deliverable must be a string of at most 65536 characters');
      }
      await teamsQ.updateDeliverable(db, request.params.id, request.projectId, deliverable);
    }

    return { ok: true };
  });
  // POST /teams/:id/launch — server-side team launch
  fastify.post<{
    Params: { id: string };
    Body: { briefPath: string };
  }>('/teams/:id/launch', {
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$', maxLength: 64 },
        },
        required: ['id'],
      },
    },
  }, async (request, reply) => {
    const teamId = request.params.id;
    const { briefPath } = request.body;
    const projectId = request.projectId;
    const db = getDb();

    if (!briefPath) {
      return reply.badRequest('briefPath is required');
    }

    // Safety B3: Validate briefPath — no path traversal
    if (briefPath.startsWith('/')) {
      return reply.badRequest('briefPath must be a relative path');
    }
    const segments = briefPath.split('/');
    if (segments.some(s => s.startsWith('.'))) {
      return reply.badRequest('briefPath must not contain dot-prefixed segments');
    }
    if (!BRIEF_PATH_RE.test(briefPath)) {
      return reply.badRequest('briefPath contains invalid characters');
    }

    let project;
    try {
      project = await resolveProject(config, db, projectId);
    } catch (err: unknown) {
      fastify.log.error(err, 'resolveProject failed for projectId=%s', projectId);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found') || msg.includes('unknown') || msg.includes('Unknown')) {
        return reply.badRequest(`Unknown project: "${projectId}"`);
      }
      return reply.badRequest(`Failed to resolve project "${projectId}": ${msg}`);
    }

    // Derive teamsDir server-side from config directory
    const teamsDir = path.resolve(config.configDir, 'teams');

    try {
      const result = await launchTeam({
        projectId,
        teamId,
        briefPath,
        teamsDir,
        project,
        db,
      });
      return { ok: true, ...result };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Log full error server-side
      fastify.log.error(err, 'Team launch failed for %s', teamId);
      // Return sanitized message — strip filesystem paths
      const sanitized = message.replace(/\/[^\s:]+/g, '<path>');
      if (message.includes('not found')) {
        return reply.notFound(sanitized);
      }
      return reply.badRequest(sanitized);
    }
  });
};

export default teamsPlugin;
