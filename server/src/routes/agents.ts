import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db.js';

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

  fastify.post<{
    Body: { name: string; worktree: string; planDoc?: string };
  }>('/agents/register', async (request) => {
    const { name, worktree, planDoc } = request.body;
    insertAgent.run({ name, worktree, planDoc: planDoc ?? null });
    return { ok: true };
  });

  fastify.get('/agents', async () => {
    return allAgents.all();
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
};

export default agentsPlugin;
