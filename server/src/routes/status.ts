import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as agentsQ from '../queries/agents.js';
import * as tasksCore from '../queries/tasks-core.js';
import * as msgQ from '../queries/messages.js';
import { formatAgent, type AgentRow } from './agents.js';
import { formatTask, type TaskRow } from './tasks-types.js';
import { formatMessage, type MessageRow } from './messages.js';

const statusPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { project?: string; since?: string; taskLimit?: string };
  }>('/status', async (request) => {
    const { project, since, taskLimit } = request.query;
    const projectId = project || request.projectId;
    const sinceNum = since ? Number(since) : 0;
    const taskLimitNum = Math.max(1, Number.isFinite(Number(taskLimit)) ? Number(taskLimit) : 20);

    const db = getDb();

    const [agentRows, taskRows, taskTotal, messageRows] = await Promise.all([
      agentsQ.getAll(db, projectId !== 'default' ? projectId : undefined),
      tasksCore.list(db, { projectId: projectId !== 'default' ? projectId : undefined, limit: taskLimitNum }),
      tasksCore.count(db, { projectId: projectId !== 'default' ? projectId : undefined }),
      msgQ.list(db, {
        channel: 'general',
        since: sinceNum || undefined,
        projectId: projectId !== 'default' ? projectId : undefined,
      }),
    ]);

    return {
      agents: agentRows.map((r) => formatAgent(r as unknown as AgentRow)),
      tasks: {
        items: taskRows.map((r) => formatTask(r as unknown as TaskRow)),
        total: taskTotal,
      },
      messages: messageRows.map((r) => formatMessage(r as unknown as MessageRow)),
    };
  });
};

export default statusPlugin;
