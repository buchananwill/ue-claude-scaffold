import type { FastifyPluginAsync } from 'fastify';
import { execFileSync } from 'node:child_process';
import { db } from '../db.js';
import type { ScaffoldConfig } from '../config.js';

interface TaskRow {
  id: number;
  title: string;
  description: string;
  source_path: string | null;
  acceptance_criteria: string | null;
  status: string;
  priority: number;
  claimed_by: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  result: string | null;
  progress_log: string | null;
  created_at: string;
}

function formatTask(row: TaskRow) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    sourcePath: row.source_path,
    acceptanceCriteria: row.acceptance_criteria,
    status: row.status,
    priority: row.priority,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    result: row.result ? JSON.parse(row.result) : null,
    progressLog: row.progress_log,
    createdAt: row.created_at,
  };
}

/**
 * Check whether a file path is committed (tracked in HEAD) at a given repo path.
 * Uses `git rev-parse HEAD:<path>` which succeeds only if the file is in the
 * latest commit — untracked or staged-but-uncommitted files will fail.
 */
function isCommittedInRepo(repoPath: string, filePath: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `HEAD:${filePath}`], {
      cwd: repoPath,
      stdio: 'ignore',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a file path exists on a specific branch in a bare repo.
 * Uses `git cat-file -e <branch>:<path>`.
 */
function existsInBareRepo(bareRepoPath: string, branch: string, filePath: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${branch}:${filePath}`], {
      cwd: bareRepoPath,
      stdio: 'ignore',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

interface TasksOpts {
  config: ScaffoldConfig;
}

const tasksPlugin: FastifyPluginAsync<TasksOpts> = async (fastify, opts) => {
  const config = opts.config;

  const insertTask = db.prepare(
    `INSERT INTO tasks (title, description, source_path, acceptance_criteria, priority)
     VALUES (@title, @description, @sourcePath, @acceptanceCriteria, @priority)`
  );

  const getTaskById = db.prepare('SELECT * FROM tasks WHERE id = @id');

  const claimTask = db.prepare(
    `UPDATE tasks SET status = 'claimed', claimed_by = @agent, claimed_at = CURRENT_TIMESTAMP
     WHERE id = @id AND status = 'pending'`
  );

  const updateProgress = db.prepare(
    `UPDATE tasks SET status = 'in_progress',
       progress_log = COALESCE(progress_log, '') || datetime('now') || ': ' || @progress || char(10)
     WHERE id = @id AND status IN ('claimed', 'in_progress')`
  );

  const completeTask = db.prepare(
    `UPDATE tasks SET status = 'completed', completed_at = CURRENT_TIMESTAMP, result = @result
     WHERE id = @id AND status IN ('claimed', 'in_progress')`
  );

  const failTask = db.prepare(
    `UPDATE tasks SET status = 'failed', completed_at = CURRENT_TIMESTAMP, result = @result
     WHERE id = @id AND status IN ('claimed', 'in_progress')`
  );

  const releaseTask = db.prepare(
    `UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL
     WHERE id = @id AND status IN ('claimed', 'in_progress')`
  );

  function getStagingWorktree(): string {
    return config.server.stagingWorktreePath ?? config.project.path;
  }

  function getBareRepoPath(): string | undefined {
    return config.server.bareRepoPath;
  }

  // POST /tasks
  fastify.post<{
    Body: {
      title: string;
      description?: string;
      sourcePath?: string;
      acceptanceCriteria?: string;
      priority?: number;
    };
  }>('/tasks', async (request, reply) => {
    const { title, description, sourcePath, acceptanceCriteria, priority } = request.body;

    // Validate sourcePath is committed in the staging worktree
    if (sourcePath) {
      const worktree = getStagingWorktree();
      if (!isCommittedInRepo(worktree, sourcePath)) {
        return reply.unprocessableEntity(
          `sourcePath '${sourcePath}' is not committed in the staging worktree (${worktree}). ` +
          `Commit it first: git add ${sourcePath} && git commit`
        );
      }
    }

    const result = insertTask.run({
      title,
      description: description ?? '',
      sourcePath: sourcePath ?? null,
      acceptanceCriteria: acceptanceCriteria ?? null,
      priority: priority ?? 0,
    });
    return { id: Number(result.lastInsertRowid), ok: true };
  });

  // GET /tasks
  fastify.get<{
    Querystring: { status?: string; limit?: string };
  }>('/tasks', async (request) => {
    const { status, limit } = request.query;
    const limitNum = limit ? Number(limit) : 50;

    let sql = 'SELECT * FROM tasks';
    const params: unknown[] = [];

    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }

    sql += ' ORDER BY priority DESC, id ASC LIMIT ?';
    params.push(limitNum);

    const rows = db.prepare(sql).all(...params) as TaskRow[];
    return rows.map(formatTask);
  });

  // GET /tasks/:id
  fastify.get<{
    Params: { id: string };
  }>('/tasks/:id', async (request, reply) => {
    const row = getTaskById.get({ id: Number(request.params.id) }) as TaskRow | undefined;
    if (!row) {
      return reply.notFound('task not found');
    }
    return formatTask(row);
  });

  // POST /tasks/:id/claim
  fastify.post<{
    Params: { id: string };
  }>('/tasks/:id/claim', async (request, reply) => {
    const id = Number(request.params.id);
    const agent = (request.headers['x-agent-name'] as string) ?? 'unknown';

    // Re-validate sourcePath against the bare repo before claiming
    const task = getTaskById.get({ id }) as TaskRow | undefined;
    if (!task) {
      return reply.notFound('task not found');
    }
    if (task.status !== 'pending') {
      return reply.conflict('task not pending');
    }

    if (task.source_path) {
      const bareRepo = getBareRepoPath();
      if (bareRepo) {
        // Determine the branch from the agent's registration
        const agentRow = db.prepare('SELECT worktree FROM agents WHERE name = ?').get(agent) as
          | { worktree: string }
          | undefined;
        const branch = agentRow?.worktree ?? 'main';

        if (!existsInBareRepo(bareRepo, branch, task.source_path)) {
          return reply.code(409).send({
            statusCode: 409,
            error: 'Conflict',
            message:
              `sourcePath '${task.source_path}' not found on branch '${branch}' in bare repo. ` +
              `The file may not be committed or pushed. ` +
              `Commit and re-run launch.sh to refresh the bare repo.`,
          });
        }
      }
    }

    const result = db.transaction(() => {
      const info = claimTask.run({ id, agent });
      return info.changes > 0;
    })();

    if (result) {
      return { ok: true };
    }
    return reply.conflict('task was claimed by another agent');
  });

  // POST /tasks/:id/update
  fastify.post<{
    Params: { id: string };
    Body: { progress: string };
  }>('/tasks/:id/update', async (request, reply) => {
    const id = Number(request.params.id);
    const { progress } = request.body;

    const info = updateProgress.run({ id, progress });
    if (info.changes === 0) {
      return reply.conflict('task not in claimed or in_progress state');
    }
    return { ok: true };
  });

  // POST /tasks/:id/complete
  fastify.post<{
    Params: { id: string };
    Body: { result: unknown };
  }>('/tasks/:id/complete', async (request, reply) => {
    const id = Number(request.params.id);
    const { result } = request.body;

    const info = completeTask.run({ id, result: JSON.stringify(result) });
    if (info.changes === 0) {
      return reply.conflict('task not in claimed or in_progress state');
    }
    return { ok: true };
  });

  // POST /tasks/:id/fail
  fastify.post<{
    Params: { id: string };
    Body: { error: string };
  }>('/tasks/:id/fail', async (request, reply) => {
    const id = Number(request.params.id);
    const { error } = request.body;

    const info = failTask.run({ id, result: JSON.stringify({ error }) });
    if (info.changes === 0) {
      return reply.conflict('task not in claimed or in_progress state');
    }
    return { ok: true };
  });

  // POST /tasks/:id/release — return a claimed/in_progress task to pending
  fastify.post<{
    Params: { id: string };
  }>('/tasks/:id/release', async (request, reply) => {
    const id = Number(request.params.id);

    const info = releaseTask.run({ id });
    if (info.changes === 0) {
      return reply.conflict('task not in claimed or in_progress state');
    }
    return { ok: true };
  });

  // DELETE /tasks/:id — delete a single task
  const deleteTask = db.prepare('DELETE FROM tasks WHERE id = @id AND status NOT IN (\'claimed\', \'in_progress\')');

  fastify.delete<{
    Params: { id: string };
  }>('/tasks/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const task = getTaskById.get({ id }) as TaskRow | undefined;
    if (!task) {
      return reply.notFound('task not found');
    }
    if (task.status === 'claimed' || task.status === 'in_progress') {
      return reply.conflict('cannot delete a task that is claimed or in progress — release it first');
    }
    deleteTask.run({ id });
    return { ok: true };
  });

  // DELETE /tasks — bulk delete by status (required query param)
  fastify.delete<{
    Querystring: { status: string };
  }>('/tasks', async (request, reply) => {
    const { status } = request.query;
    if (!status) {
      return reply.badRequest('status query parameter is required (e.g. ?status=completed)');
    }
    if (status === 'claimed' || status === 'in_progress') {
      return reply.conflict('cannot bulk-delete tasks that are claimed or in progress');
    }
    const info = db.prepare('DELETE FROM tasks WHERE status = ?').run(status);
    return { ok: true, deleted: info.changes };
  });
};

export default tasksPlugin;
