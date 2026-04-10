import type { FastifyPluginAsync } from 'fastify';
import type { DrizzleDb } from '../drizzle-instance.js';
import { getDb } from '../drizzle-instance.js';
import * as coalesceQ from '../queries/coalesce.js';
import * as agentsQ from '../queries/agents.js';

/** Result of a coalesce readiness check. */
interface CoalesceCheckResult {
  canCoalesce: boolean;
  activeTaskCount: number;
  pumpAgents: Awaited<ReturnType<typeof agentsQ.getAll>>;
  allPumpIdle: boolean;
  agentRows: Awaited<ReturnType<typeof agentsQ.getAll>>;
}

/** Check whether the system is ready to coalesce (no active tasks, all pump agents idle).
 *  Accepts optional pre-fetched agent rows to avoid redundant DB reads (TOCTOU fix). */
async function checkCanCoalesce(db: DrizzleDb, projectId: string, prefetchedAgents?: Awaited<ReturnType<typeof agentsQ.getAll>>): Promise<CoalesceCheckResult> {
  const activeTaskCount = await coalesceQ.countActiveTasks(db, projectId);
  const agentRows = prefetchedAgents ?? await agentsQ.getAll(db, projectId);
  const pumpAgents = agentRows.filter(a => a.mode === 'pump');
  const allPumpIdle = pumpAgents.every(a => ['idle', 'done', 'paused'].includes(a.status));
  return { canCoalesce: activeTaskCount === 0 && allPumpIdle, activeTaskCount, pumpAgents, allPumpIdle, agentRows };
}

const coalescePlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get('/coalesce/status', async (request) => {
    const projectId = request.projectId;
    const db = getDb();

    const { canCoalesce, activeTaskCount, pumpAgents, allPumpIdle, agentRows } = await checkCanCoalesce(db, projectId);

    const [pendingCount, claimedFileCount, agents] = await Promise.all([
      coalesceQ.countPendingTasks(db, projectId),
      coalesceQ.countClaimedFiles(db, projectId),
      Promise.all(agentRows.map(async (row) => {
        const [ownedFiles, agentActiveTasks] = await Promise.all([
          coalesceQ.getOwnedFiles(db, projectId, row.id),
          coalesceQ.countActiveTasksForAgent(db, projectId, row.id),
        ]);
        return {
          name: row.name,
          status: row.status,
          mode: row.mode,
          branch: row.worktree,
          ownedFiles,
          activeTasks: agentActiveTasks,
        };
      })),
    ]);

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
      agent: r.claimedByAgentId,
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
    Body: { timeout?: number };
  }>('/coalesce/drain', async (request, reply) => {
    const body = (request.body ?? {}) as { timeout?: number };
    const projectId = request.projectId;
    const timeout = Math.min(Math.max(body.timeout ?? 600, 1), 3600);
    const db = getDb();

    // 1. Pause pump agents
    await coalesceQ.pausePumpAgents(db, projectId);
    const pausedAgents = await coalesceQ.getPausedAgentNames(db, projectId);
    const inFlightRows = await coalesceQ.getInFlightTasks(db, projectId);

    // 2. Poll until canCoalesce or timeout
    const pollIntervalMs = 2000;
    const deadline = Date.now() + timeout * 1000;

    let pollError: string | undefined;
    try {
      while (Date.now() < deadline) {
        const poll = await checkCanCoalesce(db, projectId);

        if (poll.canCoalesce) {
          break;
        }

        if (Date.now() + pollIntervalMs >= deadline) {
          break;
        }

        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
    } catch (err) {
      pollError = err instanceof Error ? err.message : String(err);
      request.log.error({ err }, 'Drain polling loop error');
    }

    // 3. Final status check — timedOut is determined by whether we actually drained
    // (Fastify's default error handler sanitizes any uncaught errors in responses)
    const finalCheck = await checkCanCoalesce(db, projectId);
    const pendingCount = await coalesceQ.countPendingTasks(db, projectId);
    const claimedFileCount = await coalesceQ.countClaimedFiles(db, projectId);
    const timedOut = !finalCheck.canCoalesce;

    return {
      drained: finalCheck.canCoalesce,
      timedOut,
      ...(pollError ? { error: 'Drain polling interrupted; see server log for details.' } : {}),
      paused: pausedAgents,
      inFlightAtStart: inFlightRows.map(r => ({
        agent: r.claimedByAgentId,
        taskId: r.id,
        title: r.title,
      })),
      activeTasks: finalCheck.activeTaskCount,
      pendingTasks: pendingCount,
      totalClaimedFiles: claimedFileCount,
    };
  });

  fastify.post('/coalesce/release', async (request) => {
    const projectId = request.projectId;
    const db = getDb();

    const result = await db.transaction(async (tx) => {
      const fileCount = await coalesceQ.countClaimedFiles(tx, projectId);
      const agentNames = await coalesceQ.getPausedAgentNames(tx, projectId);
      await coalesceQ.releaseAllFiles(tx, projectId);
      await coalesceQ.resumePausedAgents(tx, projectId);
      return { releasedFiles: fileCount, resumedAgents: agentNames };
    });

    return result;
  });
};

export default coalescePlugin;
