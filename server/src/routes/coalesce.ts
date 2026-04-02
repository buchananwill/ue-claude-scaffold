import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as coalesceQ from '../queries/coalesce.js';
import * as agentsQ from '../queries/agents.js';

const coalescePlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get('/coalesce/status', async (request) => {
    const projectId = (request.headers['x-project-id'] as string) || 'default';
    const db = getDb();

    const activeTaskCount = await coalesceQ.countActiveTasks(db, projectId);
    const pendingCount = await coalesceQ.countPendingTasks(db, projectId);
    const claimedFileCount = await coalesceQ.countClaimedFiles(db, projectId);

    const agentRows = await agentsQ.getAll(db, projectId);
    const agents = await Promise.all(agentRows.map(async (row) => {
      const ownedFiles = await coalesceQ.getOwnedFiles(db, row.name, projectId);
      const activeTasks = await coalesceQ.countActiveTasksForAgent(db, row.name);
      return {
        name: row.name,
        status: row.status,
        mode: row.mode,
        branch: row.worktree,
        ownedFiles,
        activeTasks,
      };
    }));

    const pumpAgents = agents.filter(a => a.mode === 'pump');
    const allPumpIdle = pumpAgents.every(a => ['idle', 'done', 'paused'].includes(a.status));
    const canCoalesce = activeTaskCount === 0 && allPumpIdle;

    let reason: string | undefined;
    if (!canCoalesce) {
      if (activeTaskCount > 0) {
        reason = `${activeTaskCount} task${activeTaskCount > 1 ? 's' : ''} still in progress`;
      } else {
        const busyAgent = pumpAgents.find(a => !['idle', 'done', 'paused'].includes(a.status));
        reason = busyAgent ? `agent ${busyAgent.name} is still ${busyAgent.status}` : undefined;
      }
    }

    return {
      canCoalesce,
      ...(reason ? { reason } : {}),
      agents,
      pendingTasks: pendingCount,
      totalClaimedFiles: claimedFileCount,
    };
  });

  fastify.post('/coalesce/pause', async (request) => {
    const projectId = (request.headers['x-project-id'] as string) || 'default';
    const db = getDb();

    await coalesceQ.pausePumpAgents(db, projectId);

    const pausedAgents = await coalesceQ.getPausedAgentNames(db, projectId);
    const inFlightRows = await coalesceQ.getInFlightTasks(db, projectId);
    const inFlightTasks = inFlightRows.map(r => ({
      agent: r.claimedBy,
      taskId: r.id,
      title: r.title,
    }));

    return { paused: pausedAgents, inFlightTasks };
  });

  fastify.post('/coalesce/release', async (request) => {
    const projectId = (request.headers['x-project-id'] as string) || 'default';
    const db = getDb();

    const result = await db.transaction(async (tx) => {
      const fileCount = await coalesceQ.countClaimedFiles(tx as any, projectId);
      const agentNames = await coalesceQ.getPausedAgentNames(tx as any, projectId);
      await coalesceQ.releaseAllFiles(tx as any, projectId);
      await coalesceQ.resumePausedAgents(tx as any, projectId);
      return { releasedFiles: fileCount, resumedAgents: agentNames };
    });

    return result;
  });
};

export default coalescePlugin;
