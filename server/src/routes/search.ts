import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db.js';
import { formatTask, type TaskRow } from './tasks-types.js';
import { formatAgent, type AgentRow } from './agents.js';
import { formatMessage, type MessageRow } from './messages.js';

const searchPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { q?: string; limit?: string };
  }>('/search', async (request, reply) => {
    const { q, limit } = request.query;

    if (!q || q.length < 2) {
      return reply.badRequest('q must be at least 2 characters');
    }

    const limitNum = limit ? Number(limit) : 20;

    const taskRows = db
      .prepare(
        `SELECT * FROM tasks WHERE title LIKE '%' || ? || '%' OR description LIKE '%' || ? || '%' OR progress_log LIKE '%' || ? || '%' OR acceptance_criteria LIKE '%' || ? || '%' LIMIT ?`
      )
      .all(q, q, q, q, limitNum) as TaskRow[];

    const messageRows = db
      .prepare(
        `SELECT * FROM messages WHERE payload LIKE '%' || ? || '%' OR from_agent LIKE '%' || ? || '%' LIMIT ?`
      )
      .all(q, q, limitNum) as MessageRow[];

    const agentRows = db
      .prepare(
        `SELECT * FROM agents WHERE name LIKE '%' || ? || '%' OR worktree LIKE '%' || ? || '%' LIMIT ?`
      )
      .all(q, q, limitNum) as AgentRow[];

    return {
      tasks: taskRows.map((row) => formatTask(row)),
      messages: messageRows.map(formatMessage),
      agents: agentRows.map(formatAgent),
    };
  });
};

export default searchPlugin;
