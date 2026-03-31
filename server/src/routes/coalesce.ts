import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db.js';
import type { AgentRow } from './agents.js';

const coalescePlugin: FastifyPluginAsync = async (fastify) => {
  const countActiveTasksByProject = db.prepare(
    `SELECT COUNT(*) as count FROM tasks WHERE status IN ('claimed', 'in_progress') AND project_id = ?`
  );
  const getAgentsByProject = db.prepare('SELECT * FROM agents WHERE project_id = ?');
  const getOwnedFilesForAgentByProject = db.prepare('SELECT path FROM files WHERE claimant = ? AND project_id = ?');
  const countActiveTasksForAgent = db.prepare(
    `SELECT COUNT(*) as count FROM tasks WHERE status IN ('claimed', 'in_progress') AND claimed_by = ?`
  );
  const countPendingTasksByProject = db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE status = 'pending' AND project_id = ?`);
  const countClaimedFilesByProject = db.prepare(`SELECT COUNT(*) as count FROM files WHERE claimant IS NOT NULL AND project_id = ?`);
  const pausePumpAgentsByProject = db.prepare(
    `UPDATE agents SET status = 'paused' WHERE mode = 'pump' AND status NOT IN ('done', 'paused') AND project_id = ?`
  );
  const getInFlightTasksByProject = db.prepare(
    `SELECT id, title, claimed_by FROM tasks WHERE status IN ('claimed', 'in_progress') AND project_id = ?`
  );
  const releaseAllFilesByProject = db.prepare(
    `UPDATE files SET claimant = NULL, claimed_at = NULL WHERE claimant IS NOT NULL AND project_id = ?`
  );
  const resumePausedAgentsByProject = db.prepare(
    `UPDATE agents SET status = 'idle' WHERE status = 'paused' AND project_id = ?`
  );
  const getPausedAgentNamesByProject = db.prepare(`SELECT name FROM agents WHERE status = 'paused' AND project_id = ?`);

  fastify.get('/coalesce/status', async (request) => {
    const projectId = (request.headers['x-project-id'] as string) || 'default';
    const { count: activeTaskCount } = countActiveTasksByProject.get(projectId) as { count: number };
    const { count: pendingCount } = countPendingTasksByProject.get(projectId) as { count: number };
    const { count: claimedFileCount } = countClaimedFilesByProject.get(projectId) as { count: number };

    const agentRows = getAgentsByProject.all(projectId) as AgentRow[];
    const agents = agentRows.map(row => {
      const ownedFiles = (getOwnedFilesForAgentByProject.all(row.name, projectId) as { path: string }[]).map(f => f.path);
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

  fastify.post('/coalesce/pause', async (request) => {
    const projectId = (request.headers['x-project-id'] as string) || 'default';
    pausePumpAgentsByProject.run(projectId);

    const pausedAgents = (getPausedAgentNamesByProject.all(projectId) as { name: string }[]).map(r => r.name);
    const inFlightRows = getInFlightTasksByProject.all(projectId) as { id: number; title: string; claimed_by: string }[];
    const inFlightTasks = inFlightRows.map(r => ({
      agent: r.claimed_by,
      taskId: r.id,
      title: r.title,
    }));

    return { paused: pausedAgents, inFlightTasks };
  });

  fastify.post('/coalesce/release', async (request) => {
    const projectId = (request.headers['x-project-id'] as string) || 'default';
    const { releasedFiles, resumedAgents } = db.transaction(() => {
      const { count: fileCount } = countClaimedFilesByProject.get(projectId) as { count: number };
      const agents = (getPausedAgentNamesByProject.all(projectId) as { name: string }[]).map(r => r.name);
      releaseAllFilesByProject.run(projectId);
      resumePausedAgentsByProject.run(projectId);
      return { releasedFiles: fileCount, resumedAgents: agents };
    })();

    return { releasedFiles, resumedAgents };
  });
};

export default coalescePlugin;
