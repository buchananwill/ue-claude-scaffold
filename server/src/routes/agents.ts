import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db.js';

export interface AgentRow {
  name: string;
  worktree: string;
  plan_doc: string | null;
  status: string;
  registered_at: string;
}

export function formatAgent(row: AgentRow) {
  return {
    name: row.name,
    worktree: row.worktree,
    planDoc: row.plan_doc,
    status: row.status,
    registeredAt: row.registered_at,
  };
}

const agentsPlugin: FastifyPluginAsync = async (fastify) => {
  const insertAgent = db.prepare(
    `INSERT OR REPLACE INTO agents (name, worktree, plan_doc, status, registered_at)
     VALUES (@name, @worktree, @planDoc, 'idle', CURRENT_TIMESTAMP)`
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

  fastify.post<{
    Body: { name: string; worktree: string; planDoc?: string };
  }>('/agents/register', async (request) => {
    const { name, worktree, planDoc } = request.body;
    insertAgent.run({ name, worktree, planDoc: planDoc ?? null });
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

  // DELETE /agents/:name — deregister a single agent
  fastify.delete<{
    Params: { name: string };
  }>('/agents/:name', async (request, reply) => {
    const { name } = request.params;
    const result = db.transaction(() => {
      const info = deleteAgent.run({ name });
      if (info.changes === 0) return false;
      releaseAgentFiles.run(name);
      return true;
    })();

    if (!result) {
      return reply.notFound(`Agent '${name}' not registered`);
    }
    return { ok: true };
  });

  // DELETE /agents — deregister all agents (e.g. server restart cleanup)
  fastify.delete('/agents', async () => {
    const result = db.transaction(() => {
      const info = deleteAllAgents.run();
      db.prepare('UPDATE files SET claimant = NULL, claimed_at = NULL').run();
      return info.changes;
    })();
    return { ok: true, removed: result };
  });
};

export default agentsPlugin;
