import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as tasksCore from '../queries/tasks-core.js';
import * as tasksClaimQ from '../queries/tasks-claim.js';
import * as tasksLifecycleQ from '../queries/tasks-lifecycle.js';
import * as taskFilesQ from '../queries/task-files.js';
import * as agentsQ from '../queries/agents.js';
import { existsInBareRepo } from '../git-utils.js';
import { seedBranchFor, AGENT_NAME_RE } from '../branch-naming.js';
import { resolveProject } from '../resolve-project.js';
import { toTaskRow, type TaskRow } from './tasks-types.js';
import {
  type TasksOpts,
  blockersForTask,
  blockReasonsForTask,
  formatTaskWithFiles,
  checkAndClaimFiles,
} from './tasks-files.js';
import type { ScaffoldConfig } from '../config.js';

const tasksClaimPlugin: FastifyPluginAsync<TasksOpts> = async (fastify, opts) => {
  const config = opts.config;

  /** Validate a task's sourcePath exists in the bare repo on an appropriate branch. */
  async function validateSourcePathForClaim(
    task: { source_path?: string | null; sourcePath?: string | null; project_id?: string; projectId?: string },
    agent: string,
  ): Promise<{ valid: boolean; branch?: string }> {
    const sp = task.sourcePath ?? task.source_path;
    if (!sp) return { valid: true };
    const taskProjectId = task.projectId ?? task.project_id ?? 'default';

    const db = getDb();

    let bareRepo: string;
    let seedBranch: string;
    try {
      const project = await resolveProject(config, db, taskProjectId);
      bareRepo = project.bareRepoPath;
      seedBranch = seedBranchFor(taskProjectId, project);
    } catch {
      bareRepo = config.server.bareRepoPath;
      seedBranch = seedBranchFor(taskProjectId);
    }
    if (!bareRepo) return { valid: true };

    const agentRow = await agentsQ.getWorktreeInfo(db, agent);
    const branch = agentRow?.worktree ?? seedBranch;

    if (existsInBareRepo(bareRepo, branch, sp)) {
      return { valid: true, branch };
    }
    // Fallback: if agent branch differs from seedBranch, try seedBranch
    if (branch !== seedBranch && existsInBareRepo(bareRepo, seedBranch, sp)) {
      return { valid: true, branch: seedBranch };
    }
    return { valid: false, branch };
  }

  fastify.post('/tasks/claim-next', async (request, reply) => {
    const agent = (request.headers['x-agent-name'] as string) ?? 'unknown';
    if (agent !== 'unknown' && !AGENT_NAME_RE.test(agent)) {
      return reply.badRequest('Invalid X-Agent-Name header format');
    }
    const db = getDb();
    const agentProjectId = await agentsQ.getProjectId(db, agent);
    const projectId = agentProjectId ?? 'default';

    // Query returns up to 10 candidates sorted by priority
    const candidates = await tasksClaimQ.claimNextCandidate(db, projectId, agent);

    const skippedSourcePath: number[] = [];

    for (const candidate of candidates) {
      const taskRow = await tasksCore.getById(db, candidate.id);
      if (!taskRow) continue;

      const spCheck = await validateSourcePathForClaim(taskRow, agent);
      if (!spCheck.valid) {
        skippedSourcePath.push(candidate.id);
        continue;
      }

      // Claim the task
      await tasksLifecycleQ.claim(db, candidate.id, agent);

      // Claim its files
      const fileDeps = await taskFilesQ.getFilesForTask(db, candidate.id);
      const taskProjectId = taskRow.projectId ?? (taskRow as any).project_id ?? 'default';
      for (const fp of fileDeps) {
        await taskFilesQ.claimFilesForAgent(db, agent, taskProjectId, fp);
      }

      const row = await tasksCore.getById(db, candidate.id);
      const response: Record<string, unknown> = { task: await formatTaskWithFiles(toTaskRow(row!), agent, config) };
      if (skippedSourcePath.length > 0) {
        response.skippedSourcePath = skippedSourcePath;
      }
      return response;
    }

    // No candidate was claimable
    const pendingCount = await tasksClaimQ.countPending(db, projectId);
    if (pendingCount === 0 && skippedSourcePath.length === 0) {
      return { task: null, pending: 0, blocked: 0 };
    }
    const blockedCount = await tasksClaimQ.countBlocked(db, projectId, agent);
    const depBlockedCount = await tasksClaimQ.countDepBlocked(db, projectId, agent);
    const response: Record<string, unknown> = {
      task: null,
      pending: pendingCount,
      blocked: blockedCount,
      depBlocked: depBlockedCount,
      reason: 'all pending tasks have file conflicts, unmet dependencies, or missing sourcePaths',
    };
    if (skippedSourcePath.length > 0) {
      response.skippedSourcePath = skippedSourcePath;
      response.sourcePathNote = 'these task IDs were skipped because their sourcePath was not found in the bare repo';
    }
    return response;
  });

  // POST /tasks/:id/claim
  fastify.post<{
    Params: { id: string };
  }>('/tasks/:id/claim', async (request, reply) => {
    const id = Number(request.params.id);
    const agent = (request.headers['x-agent-name'] as string) ?? 'unknown';
    if (agent !== 'unknown' && !AGENT_NAME_RE.test(agent)) {
      return reply.badRequest('Invalid X-Agent-Name header format');
    }
    const db = getDb();

    // Re-validate sourcePath against the bare repo before claiming
    const task = await tasksCore.getById(db, id);
    if (!task) {
      return reply.notFound('task not found');
    }
    if (task.status !== 'pending') {
      return reply.conflict('task not pending');
    }

    const spCheck = await validateSourcePathForClaim(task, agent);
    if (!spCheck.valid) {
      const sp = task.sourcePath ?? (task as any).source_path;
      const displayPath = sp.length > 256 ? sp.slice(0, 256) + '\u2026' : sp;
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message:
          `sourcePath '${displayPath}' not found on branch '${spCheck.branch}' in bare repo. ` +
          `The file may not be committed or pushed. ` +
          `Commit and re-run launch.sh to refresh the bare repo.`,
      });
    }

    const blockers = await blockersForTask(id, agent);
    if (blockers.length > 0) {
      const blockReasons = (await blockReasonsForTask(toTaskRow(task), agent, config))
        .filter(r => r.startsWith('blocked by'));
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Task has unmet dependencies',
        blockedBy: blockers,
        blockReasons,
      });
    }

    const ownershipResult = await checkAndClaimFiles(id, agent);
    if (ownershipResult !== null && ownershipResult.length > 0) {
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'File ownership conflict — files are owned by another agent and cannot be claimed until reconciliation',
        conflicts: ownershipResult,
      });
    }

    const ok = await tasksLifecycleQ.claim(db, id, agent);

    if (ok) {
      return { ok: true };
    }
    return reply.conflict('task was claimed by another agent');
  });

  // POST /tasks/:id/release — return a claimed/in_progress task to pending
  fastify.post<{
    Params: { id: string };
  }>('/tasks/:id/release', async (request, reply) => {
    const id = Number(request.params.id);
    const db = getDb();

    const ok = await tasksLifecycleQ.release(db, id);
    if (!ok) {
      return reply.conflict('task not in claimed or in_progress state');
    }
    return { ok: true };
  });

  // POST /tasks/:id/update
  fastify.post<{
    Params: { id: string };
    Body: { progress: string };
  }>('/tasks/:id/update', async (request, reply) => {
    const id = Number(request.params.id);
    const { progress } = request.body;
    const db = getDb();

    const ok = await tasksLifecycleQ.updateProgress(db, id, progress);
    if (!ok) {
      return reply.conflict('task not in claimed or in_progress state');
    }
    return { ok: true };
  });
};

export default tasksClaimPlugin;
