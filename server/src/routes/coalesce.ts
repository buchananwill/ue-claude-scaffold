import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as coalesceQ from '../queries/coalesce.js';
import * as agentsQ from '../queries/agents.js';

const coalescePlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get('/coalesce/status', async (request) => {
    const projectId = request.projectId;
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
    const projectId = request.projectId;
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

  // POST /coalesce/drain — run the full drain state machine:
  //   1. Pause pump agents
  //   2. Poll until canCoalesce or timeout
  //   3. Return final status
  fastify.post<{
    Body: { timeout?: number; projectId?: string };
  }>('/coalesce/drain', async (request, reply) => {
    const body = (request.body ?? {}) as { timeout?: number; projectId?: string };
    const projectId = body.projectId ?? request.projectId;
    const timeout = Math.min(Math.max(body.timeout ?? 600, 1), 3600);
    const db = getDb();

    // 1. Pause pump agents
    await coalesceQ.pausePumpAgents(db, projectId);
    const pausedAgents = await coalesceQ.getPausedAgentNames(db, projectId);
    const inFlightRows = await coalesceQ.getInFlightTasks(db, projectId);

    // 2. Poll until canCoalesce or timeout
    const pollIntervalMs = 2000;
    const deadline = Date.now() + timeout * 1000;
    let timedOut = false;

    while (Date.now() < deadline) {
      const activeTaskCount = await coalesceQ.countActiveTasks(db, projectId);
      const agentRows = await agentsQ.getAll(db, projectId);
      const pumpAgents = agentRows.filter(a => a.mode === 'pump');
      const allPumpIdle = pumpAgents.every(a =>
        ['idle', 'done', 'paused'].includes(a.status));

      if (activeTaskCount === 0 && allPumpIdle) {
        break;
      }

      if (Date.now() + pollIntervalMs >= deadline) {
        timedOut = true;
        break;
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    // 3. Return final status
    const activeTaskCount = await coalesceQ.countActiveTasks(db, projectId);
    const pendingCount = await coalesceQ.countPendingTasks(db, projectId);
    const claimedFileCount = await coalesceQ.countClaimedFiles(db, projectId);
    const agentRows = await agentsQ.getAll(db, projectId);
    const pumpAgents = agentRows.filter(a => a.mode === 'pump');
    const allPumpIdle = pumpAgents.every(a =>
      ['idle', 'done', 'paused'].includes(a.status));
    const canCoalesce = activeTaskCount === 0 && allPumpIdle;

    return {
      drained: canCoalesce,
      timedOut: timedOut ?? false,
      paused: pausedAgents,
      inFlightAtStart: inFlightRows.map(r => ({
        agent: r.claimedBy,
        taskId: r.id,
        title: r.title,
      })),
      activeTasks: activeTaskCount,
      pendingTasks: pendingCount,
      totalClaimedFiles: claimedFileCount,
    };
  });

  fastify.post('/coalesce/release', async (request) => {
    const projectId = request.projectId;
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
