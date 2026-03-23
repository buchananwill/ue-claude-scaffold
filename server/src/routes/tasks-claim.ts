import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db.js';
import { existsInBareRepo } from '../git-utils.js';
import type { TaskRow } from './tasks-types.js';
import type { TasksOpts, TasksSharedStatements } from './tasks-files.js';

interface TasksClaimOpts extends TasksOpts {
  shared: TasksSharedStatements;
}

const tasksClaimPlugin: FastifyPluginAsync<TasksClaimOpts> = async (fastify, opts) => {
  const config = opts.config;
  const shared = opts.shared;

  const claimNextCandidate = db.prepare(`
    SELECT t.id,
      -- Guard against LEFT JOIN null row: without this, tasks with zero file deps
      -- would score new_locks=1 instead of 0 (NULL IS NULL = true in the CASE)
      COUNT(CASE WHEN tf.file_path IS NOT NULL AND f.claimant IS NULL THEN 1 END) as new_locks
    FROM tasks t
    LEFT JOIN task_files tf ON tf.task_id = t.id
    LEFT JOIN files f ON f.path = tf.file_path
    WHERE t.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM task_files tf2
        JOIN files f2 ON f2.path = tf2.file_path
        WHERE tf2.task_id = t.id
          AND f2.claimant IS NOT NULL
          AND f2.claimant != ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies d
        JOIN tasks dep ON dep.id = d.depends_on
        WHERE d.task_id = t.id
          AND NOT (
            dep.status = 'integrated'
            OR (dep.status = 'completed' AND json_extract(dep.result, '$.agent') = ?)
          )
      )
    GROUP BY t.id
    ORDER BY
      CASE WHEN EXISTS (
        SELECT 1 FROM task_dependencies d
        JOIN tasks dep ON dep.id = d.depends_on
        WHERE d.task_id = t.id
          AND dep.status = 'completed'
          AND json_extract(dep.result, '$.agent') = ?
      ) THEN 0 ELSE 1 END ASC,
      new_locks ASC,
      t.priority DESC,
      t.id ASC
    LIMIT 10
  `);

  const countPending = db.prepare(
    `SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'`
  );

  const countBlocked = db.prepare(`
    SELECT COUNT(DISTINCT t.id) as count
    FROM tasks t
    JOIN task_files tf ON tf.task_id = t.id
    JOIN files f ON f.path = tf.file_path
    WHERE t.status = 'pending'
      AND f.claimant IS NOT NULL
      AND f.claimant != ?
  `);

  const countDepBlocked = db.prepare(`
    SELECT COUNT(DISTINCT t.id) as count
    FROM tasks t
    WHERE t.status = 'pending'
      AND EXISTS (
        SELECT 1 FROM task_dependencies d
        JOIN tasks dep ON dep.id = d.depends_on
        WHERE d.task_id = t.id
          AND NOT (
            dep.status = 'integrated'
            OR (dep.status = 'completed' AND json_extract(dep.result, '$.agent') = ?)
          )
      )
  `);

  /** Validate a task's sourcePath exists in the bare repo on an appropriate branch. */
  function validateSourcePathForClaim(
    task: { source_path: string | null },
    agent: string,
  ): { valid: boolean; branch?: string } {
    if (!task.source_path) return { valid: true };
    const bareRepo = shared.getBareRepoPath();
    if (!bareRepo) return { valid: true };

    const agentRow = db.prepare('SELECT worktree FROM agents WHERE name = ?').get(agent) as
      | { worktree: string }
      | undefined;
    const planBranch = config.tasks?.planBranch ?? 'docker/current-root';
    const branch = agentRow?.worktree ?? planBranch;

    if (existsInBareRepo(bareRepo, branch, task.source_path)) {
      return { valid: true, branch };
    }
    // Fallback: if agent branch differs from planBranch, try planBranch
    if (branch !== planBranch && existsInBareRepo(bareRepo, planBranch, task.source_path)) {
      return { valid: true, branch: planBranch };
    }
    return { valid: false, branch };
  }

  fastify.post('/tasks/claim-next', async (request) => {
    const agent = (request.headers['x-agent-name'] as string) ?? 'unknown';

    const result = db.transaction(() => {
      // Query returns up to 10 candidates sorted by priority; we iterate to find
      // the first one whose sourcePath is valid (the DB can't check the bare repo).
      const candidates = claimNextCandidate.all(agent, agent, agent) as
        Array<{ id: number; new_locks: number }>;

      const skippedSourcePath: number[] = [];

      for (const candidate of candidates) {
        const taskRow = shared.getTaskById.get({ id: candidate.id }) as TaskRow;
        const spCheck = validateSourcePathForClaim(taskRow, agent);
        if (!spCheck.valid) {
          skippedSourcePath.push(candidate.id);
          continue;
        }

        // Claim the task
        shared.claimTask.run({ id: candidate.id, agent });

        // Claim its files
        const fileDeps = (shared.getTaskFiles.all(candidate.id) as { file_path: string }[])
          .map(r => r.file_path);
        for (const fp of fileDeps) {
          shared.claimFilesForAgent.run(agent, fp);
        }

        const row = shared.getTaskById.get({ id: candidate.id }) as TaskRow;
        const response: Record<string, unknown> = { task: shared.formatTaskWithFiles(row, agent) };
        if (skippedSourcePath.length > 0) {
          response.skippedSourcePath = skippedSourcePath;
        }
        return response;
      }

      // No candidate was claimable
      const { count: pendingCount } = countPending.get() as { count: number };
      if (pendingCount === 0 && skippedSourcePath.length === 0) {
        return { task: null, pending: 0, blocked: 0 };
      }
      const { count: blockedCount } = countBlocked.get(agent) as { count: number };
      const { count: depBlockedCount } = countDepBlocked.get(agent) as { count: number };
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
    })();

    return result;
  });

  // POST /tasks/:id/claim
  fastify.post<{
    Params: { id: string };
  }>('/tasks/:id/claim', async (request, reply) => {
    const id = Number(request.params.id);
    const agent = (request.headers['x-agent-name'] as string) ?? 'unknown';

    // Re-validate sourcePath against the bare repo before claiming
    const task = shared.getTaskById.get({ id }) as TaskRow | undefined;
    if (!task) {
      return reply.notFound('task not found');
    }
    if (task.status !== 'pending') {
      return reply.conflict('task not pending');
    }

    const spCheck = validateSourcePathForClaim(task, agent);
    if (!spCheck.valid) {
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message:
          `sourcePath '${task.source_path}' not found on branch '${spCheck.branch}' in bare repo. ` +
          `The file may not be committed or pushed. ` +
          `Commit and re-run launch.sh to refresh the bare repo.`,
      });
    }

    const blockers = shared.blockersForTask(id, agent);
    if (blockers.length > 0) {
      const blockReasons = shared.blockReasonsForTask(task, agent).filter(r => r.startsWith('blocked by'));
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Task has unmet dependencies',
        blockedBy: blockers,
        blockReasons,
      });
    }

    const result = db.transaction(() => {
      const ownershipResult = shared.checkAndClaimFiles(id, agent);
      if (ownershipResult !== null && ownershipResult.length > 0) {
        return { ok: false as const, conflicts: ownershipResult };
      }
      const info = shared.claimTask.run({ id, agent });
      return { ok: info.changes > 0, conflicts: undefined };
    })();

    if (!result.ok && result.conflicts) {
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'File ownership conflict — files are owned by another agent and cannot be claimed until reconciliation',
        conflicts: result.conflicts,
      });
    }

    if (result.ok) {
      return { ok: true };
    }
    return reply.conflict('task was claimed by another agent');
  });

  // POST /tasks/:id/release — return a claimed/in_progress task to pending
  fastify.post<{
    Params: { id: string };
  }>('/tasks/:id/release', async (request, reply) => {
    const id = Number(request.params.id);

    const info = shared.releaseTask.run({ id });
    if (info.changes === 0) {
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

    const info = shared.updateProgress.run({ id, progress });
    if (info.changes === 0) {
      return reply.conflict('task not in claimed or in_progress state');
    }
    return { ok: true };
  });
};

export default tasksClaimPlugin;
