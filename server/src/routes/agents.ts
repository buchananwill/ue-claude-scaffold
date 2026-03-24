import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db.js';
import type { ScaffoldConfig } from '../config.js';
import { mergeIntoBranch } from '../git-utils.js';

interface AgentsOpts { config: ScaffoldConfig }

export interface AgentRow {
  name: string;
  worktree: string;
  plan_doc: string | null;
  status: string;
  mode: string;
  registered_at: string;
  container_host: string | null;
}

export function formatAgent(row: AgentRow) {
  return {
    name: row.name,
    worktree: row.worktree,
    planDoc: row.plan_doc,
    status: row.status,
    mode: row.mode,
    registeredAt: row.registered_at,
    containerHost: row.container_host,
  };
}

const agentsPlugin: FastifyPluginAsync<AgentsOpts> = async (fastify, opts) => {
  const { config } = opts;
  const insertAgent = db.prepare(
    `INSERT INTO agents (name, worktree, plan_doc, status, mode, registered_at, container_host)
     VALUES (@name, @worktree, @planDoc, 'idle', @mode, CURRENT_TIMESTAMP, @containerHost)
     ON CONFLICT(name) DO UPDATE SET
       worktree = excluded.worktree,
       plan_doc = excluded.plan_doc,
       status = 'idle',
       mode = excluded.mode,
       registered_at = CURRENT_TIMESTAMP,
       container_host = COALESCE(excluded.container_host, agents.container_host)`
  );

  const allAgents = db.prepare('SELECT * FROM agents');

  const updateStatus = db.prepare(
    'UPDATE agents SET status = @status WHERE name = @name'
  );

  const getAgent = db.prepare('SELECT * FROM agents WHERE name = @name');

  const deleteAgent = db.prepare('DELETE FROM agents WHERE name = @name');

  const deleteAllAgents = db.prepare('DELETE FROM agents');

  const releaseAgentFiles = db.prepare(
    'UPDATE files SET claimant = NULL, claimed_at = NULL WHERE claimant = ?'
  );

  const releaseAgentTasks = db.prepare(
    `UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL
     WHERE claimed_by = @name AND status IN ('claimed', 'in_progress')`
  );

  fastify.post<{
    Body: { name: string; worktree: string; planDoc?: string; mode?: 'single' | 'pump'; containerHost?: string };
  }>('/agents/register', async (request) => {
    const { name, worktree, planDoc, mode, containerHost } = request.body;
    insertAgent.run({ name, worktree, planDoc: planDoc ?? null, mode: mode ?? 'single', containerHost: containerHost ?? null });

    const roomId = `${name}-direct`;
    const existingRoom = db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId);
    if (!existingRoom) {
      db.transaction(() => {
        db.prepare('INSERT INTO rooms (id, name, type, created_by) VALUES (?, ?, ?, ?)').run(roomId, `Direct: ${name}`, 'direct', name);
        db.prepare('INSERT OR IGNORE INTO room_members (room_id, member) VALUES (?, ?)').run(roomId, name);
        db.prepare('INSERT OR IGNORE INTO room_members (room_id, member) VALUES (?, ?)').run(roomId, 'user');
      })();
    }

    return { ok: true };
  });

  fastify.get('/agents', async () => {
    return (allAgents.all() as AgentRow[]).map(formatAgent);
  });

  // GET /agents/:name — fetch a single agent by name
  fastify.get<{
    Params: { name: string };
  }>('/agents/:name', async (request, reply) => {
    const row = getAgent.get({ name: request.params.name }) as AgentRow | undefined;
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
    const agent = getAgent.get({ name });
    if (!agent) {
      return reply.notFound(`Agent '${name}' not registered`);
    }
    updateStatus.run({ name, status });
    return { ok: true };
  });

  const setStoppingStatus = db.prepare(
    "UPDATE agents SET status = 'stopping' WHERE name = @name"
  );

  // DELETE /agents/:name — deregister a single agent
  // First call (operator): sets status to 'stopping', releases file ownership.
  // Second call (container self-deregister): hard-deletes the row.
  fastify.delete<{
    Params: { name: string };
  }>('/agents/:name', async (request, reply) => {
    const { name } = request.params;
    const agent = getAgent.get({ name }) as AgentRow | undefined;
    if (!agent) {
      return reply.notFound(`Agent '${name}' not registered`);
    }

    if (agent.status === 'stopping') {
      // Second call — container acknowledging stop; hard-delete the row
      db.transaction(() => {
        deleteAgent.run({ name });
        releaseAgentFiles.run(name);
      })();
      return { ok: true };
    }

    // First call — operator initiating shutdown; set status to stopping
    db.transaction(() => {
      setStoppingStatus.run({ name });
      releaseAgentFiles.run(name);
      releaseAgentTasks.run({ name });
    })();
    return { ok: true, stopping: true };
  });

  // DELETE /agents — deregister all agents (e.g. server restart cleanup)
  fastify.delete('/agents', async () => {
    const result = db.transaction(() => {
      const info = deleteAllAgents.run();
      db.prepare('UPDATE files SET claimant = NULL, claimed_at = NULL').run();
      db.prepare("UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL WHERE status IN ('claimed', 'in_progress')").run();
      return info.changes;
    })();
    return { ok: true, removed: result };
  });

  // POST /agents/:name/sync — merge plan branch into agent's branch
  fastify.post<{ Params: { name: string } }>('/agents/:name/sync', async (request, reply) => {
    const { name } = request.params;

    const agent = db.prepare('SELECT name, worktree FROM agents WHERE name = ?').get(name);
    if (!agent) {
      return reply.notFound(`Agent '${name}' not found`);
    }

    const bareRepo = config.server.bareRepoPath;
    if (!bareRepo) {
      return reply.code(422).send({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'sync requires server.bareRepoPath to be configured',
      });
    }

    const planBranch = config.tasks?.planBranch ?? 'docker/current-root';
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
