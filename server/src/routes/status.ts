import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as agentsQ from '../queries/agents.js';
import * as tasksCore from '../queries/tasks-core.js';
import * as msgQ from '../queries/messages.js';
import { formatAgent } from './agents.js';
import { formatTask, type TaskRow } from './tasks-types.js';
import { formatMessage } from './messages.js';

const MESSAGE_LIMIT = 200;

const statusPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { since?: string; taskLimit?: string };
  }>('/status', async (request, reply) => {
    const { since, taskLimit } = request.query;
    const projectId = request.projectId;

    // Validate since parameter: must be a non-negative integer if provided
    let sinceNum: number | undefined;
    if (since != null && since !== '') {
      const parsed = Number(since);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed !== Math.floor(parsed)) {
        return reply.badRequest('since must be a non-negative integer');
      }
      sinceNum = parsed;
    }

    // Validate and clamp taskLimit to [1, 200]
    let taskLimitNum = 20;
    if (taskLimit != null && taskLimit !== '') {
      const parsedLimit = Number(taskLimit);
      if (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit !== Math.floor(parsedLimit)) {
        return reply.badRequest('taskLimit must be a positive integer');
      }
      taskLimitNum = Math.min(parsedLimit, 200);
    }

    const db = getDb();
    const projectFilter = projectId;

    const [agentRows, taskRows, taskTotal, messageRows] = await Promise.all([
      agentsQ.getAll(db, projectFilter),
      tasksCore.list(db, { projectId: projectFilter, limit: taskLimitNum }),
      tasksCore.count(db, { projectId: projectFilter }),
      msgQ.list(db, {
        channel: 'general',
        since: sinceNum,
        limit: MESSAGE_LIMIT,
        projectId: projectFilter,
      }),
    ]);

    return {
      agents: agentRows.map(formatAgent),
      tasks: {
        // Cast needed: Drizzle returns camelCase fields but TaskRow declares snake_case as required;
        // formatTask's pick() helper handles both naming conventions.
        items: taskRows.map((r) => formatTask(r as unknown as TaskRow)),
        total: taskTotal,
      },
      messages: messageRows.map(formatMessage),
    };
  });
};

export default statusPlugin;
