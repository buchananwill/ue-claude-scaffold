import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db.js';
import type { AgentRow } from './agents.js';

const coalescePlugin: FastifyPluginAsync = async (fastify) => {
  const countActiveTasks = db.prepare(
    `SELECT COUNT(*) as count FROM tasks WHERE status IN ('claimed', 'in_progress')`
  );
  const getAllAgents = db.prepare('SELECT * FROM agents');
  const getOwnedFilesForAgent = db.prepare('SELECT path FROM files WHERE claimant = ?');
  const countActiveTasksForAgent = db.prepare(
    `SELECT COUNT(*) as count FROM tasks WHERE status IN ('claimed', 'in_progress') AND claimed_by = ?`
  );
  const countPendingTasks = db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'`);
  const countClaimedFiles = db.prepare(`SELECT COUNT(*) as count FROM files WHERE claimant IS NOT NULL`);
  const pausePumpAgents = db.prepare(
    `UPDATE agents SET status = 'paused' WHERE mode = 'pump' AND status NOT IN ('done', 'paused')`
  );
  const getInFlightTasks = db.prepare(
    `SELECT id, title, claimed_by FROM tasks WHERE status IN ('claimed', 'in_progress')`
  );
  const releaseAllFiles = db.prepare(
    `UPDATE files SET claimant = NULL, claimed_at = NULL WHERE claimant IS NOT NULL`
  );
  const resumePausedAgents = db.prepare(
    `UPDATE agents SET status = 'idle' WHERE status = 'paused'`
  );
  const getPausedAgentNames = db.prepare(`SELECT name FROM agents WHERE status = 'paused'`);

  fastify.get('/coalesce/status', async () => {
    const { count: activeTaskCount } = countActiveTasks.get() as { count: number };
    const { count: pendingCount } = countPendingTasks.get() as { count: number };
    const { count: claimedFileCount } = countClaimedFiles.get() as { count: number };

    const agentRows = getAllAgents.all() as AgentRow[];
    const agents = agentRows.map(row => {
      const ownedFiles = (getOwnedFilesForAgent.all(row.name) as { path: string }[]).map(f => f.path);
      const { count: activeTasks } = countActiveTasksForAgent.get(row.name) as { count: number };
      return {
        name: row.name,
        status: row.status,
        mode: row.mode,
        branch: row.worktree,
        ownedFiles,
        activeTasks,
      };
    });

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

  fastify.post('/coalesce/pause', async () => {
    pausePumpAgents.run();

    const pausedAgents = (getPausedAgentNames.all() as { name: string }[]).map(r => r.name);
    const inFlightRows = getInFlightTasks.all() as { id: number; title: string; claimed_by: string }[];
    const inFlightTasks = inFlightRows.map(r => ({
      agent: r.claimed_by,
      taskId: r.id,
      title: r.title,
    }));

    return { paused: pausedAgents, inFlightTasks };
  });

  fastify.post('/coalesce/release', async () => {
    const { releasedFiles, resumedAgents } = db.transaction(() => {
      const { count: fileCount } = countClaimedFiles.get() as { count: number };
      const agents = (getPausedAgentNames.all() as { name: string }[]).map(r => r.name);
      releaseAllFiles.run();
      resumePausedAgents.run();
      return { releasedFiles: fileCount, resumedAgents: agents };
    })();

    return { releasedFiles, resumedAgents };
  });
};

export default coalescePlugin;
