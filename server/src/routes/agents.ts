import type { FastifyPluginAsync } from 'fastify';
import { randomBytes } from 'node:crypto';
import { getDb } from '../drizzle-instance.js';
import * as agentsQ from '../queries/agents.js';
import * as roomsQ from '../queries/rooms.js';
import * as filesQ from '../queries/files.js';
import * as tasksLifecycleQ from '../queries/tasks-lifecycle.js';
import * as projectsQ from '../queries/projects.js';
import type { ScaffoldConfig } from '../config.js';
import { getProject } from '../config.js';
import { mergeIntoBranch } from '../git-utils.js';

interface AgentsOpts { config: ScaffoldConfig }

export interface AgentRow {
  name: string;
  worktree: string;
  planDoc: string | null;
  status: string;
  mode: string;
  registeredAt: string | Date | null;
  containerHost: string | null;
  projectId: string;
}

export function formatAgent(row: AgentRow) {
  return {
    name: row.name,
    worktree: row.worktree,
    planDoc: row.planDoc ?? null,
    status: row.status,
    mode: row.mode,
    registeredAt: row.registeredAt ?? null,
    containerHost: row.containerHost ?? null,
    projectId: row.projectId ?? 'default',
  };
}

const agentsPlugin: FastifyPluginAsync<AgentsOpts> = async (fastify, opts) => {
  const { config } = opts;

  fastify.post<{
    Body: { name: string; worktree: string; planDoc?: string; mode?: 'single' | 'pump'; containerHost?: string };
  }>('/agents/register', async (request) => {
    const { name, worktree, planDoc, mode, containerHost } = request.body;
    const projectId = request.projectId;
    const sessionToken = randomBytes(16).toString('hex');
    const db = getDb();

    await agentsQ.register(db, {
      name,
      worktree,
      planDoc: planDoc ?? null,
      mode: mode ?? 'single',
      containerHost: containerHost ?? null,
      sessionToken,
      projectId,
    });

    const roomId = `${name}-direct`;
    const existingRoom = await roomsQ.getRoom(db, roomId);
    if (!existingRoom) {
      await roomsQ.createRoom(db, {
        id: roomId,
        name: `Direct: ${name}`,
        type: 'direct',
        createdBy: name,
        projectId,
      });
      await roomsQ.addMember(db, roomId, name);
      await roomsQ.addMember(db, roomId, 'user');
    }

    return { ok: true, sessionToken };
  });

  fastify.get<{
    Querystring: { project?: string };
  }>('/agents', async (request) => {
    const { project } = request.query;
    const db = getDb();
    const rows = await agentsQ.getAll(db, project || undefined);
    return rows.map(formatAgent);
  });

  // GET /agents/:name — fetch a single agent by name
  fastify.get<{
    Params: { name: string };
  }>('/agents/:name', async (request, reply) => {
    const db = getDb();
    const row = await agentsQ.getByName(db, request.params.name);
    if (!row) {
      return reply.notFound(`Agent '${request.params.name}' not registered`);
    }
    return formatAgent(row);
  });

  fastify.post<{
    Params: { name: string };
    Body: { status: string };
  }>('/agents/:name/status', async (request, reply) => {
    const { name } = request.params;
    const { status } = request.body;
    const db = getDb();
    const agent = await agentsQ.getByName(db, name);
    if (!agent) {
      return reply.notFound(`Agent '${name}' not registered`);
    }
    await agentsQ.updateStatus(db, name, status);
    return { ok: true };
  });

  // DELETE /agents/:name — deregister a single agent
  // First call (operator): sets status to 'stopping', releases file ownership.
  // Second call (container self-deregister): hard-deletes the row.
  fastify.delete<{
    Params: { name: string };
  }>('/agents/:name', async (request, reply) => {
    const { name } = request.params;
    const db = getDb();
    const agent = await agentsQ.getByName(db, name);
    if (!agent) {
      return reply.notFound(`Agent '${name}' not registered`);
    }

    if (agent.status === 'stopping') {
      // Second call — container acknowledging stop; hard-delete the row
      await db.transaction(async (tx) => {
        await agentsQ.hardDelete(tx as any, name);
        await filesQ.releaseByClaimant(tx as any, name);
      });
      return { ok: true };
    }

    // First call — operator initiating shutdown; set status to stopping
    await db.transaction(async (tx) => {
      await agentsQ.softDelete(tx as any, name);
      await filesQ.releaseByClaimant(tx as any, name);
      await tasksLifecycleQ.releaseByAgent(tx as any, name);
    });
    return { ok: true, stopping: true };
  });

  // DELETE /agents — deregister all agents (e.g. server restart cleanup)
  fastify.delete('/agents', async () => {
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      const count = await agentsQ.deleteAll(tx as any);
      await filesQ.releaseAll(tx as any);
      await tasksLifecycleQ.releaseAllActive(tx as any);
      return count;
    });
    return { ok: true, removed: result };
  });

  // POST /agents/:name/sync — merge plan branch into agent's branch
  fastify.post<{ Params: { name: string } }>('/agents/:name/sync', async (request, reply) => {
    const { name } = request.params;
    const db = getDb();

    const agent = await agentsQ.getWorktreeInfo(db, name);
    if (!agent) {
      return reply.notFound(`Agent '${name}' not found`);
    }

    let project;
    try {
      const dbRow = await projectsQ.getById(db, agent.projectId);
      project = getProject(config, agent.projectId, dbRow ?? undefined);
    } catch {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `Unknown project: "${agent.projectId}"`,
      });
    }
    const bareRepo = project.bareRepoPath;
    if (!bareRepo) {
      return reply.code(422).send({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'sync requires bareRepoPath to be configured',
      });
    }

    const planBranch = project.planBranch ?? 'docker/current-root';
    const targetBranch = `docker/${name}`;

    const result = mergeIntoBranch(bareRepo, planBranch, targetBranch);
    if (result.ok) {
      return reply.send({ ok: true, ...(result.commitSha ? { commitSha: result.commitSha } : {}) });
    } else {
      return reply.code(409).send({ ok: false, reason: result.reason });
    }
  });
};

export default agentsPlugin;
