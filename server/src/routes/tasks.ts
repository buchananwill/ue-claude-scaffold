import type { FastifyPluginAsync } from 'fastify';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { db } from '../db.js';
import type { ScaffoldConfig } from '../config.js';

export interface TaskRow {
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

export function formatTask(row: TaskRow, files?: string[]) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    sourcePath: row.source_path,
    acceptanceCriteria: row.acceptance_criteria,
    status: row.status,
    priority: row.priority,
    files: files ?? [],
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

interface ConflictInfo {
  file: string;
  claimant: string;
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

  const resetTask = db.prepare(
    `UPDATE tasks
     SET status = 'pending',
         claimed_by = NULL,
         claimed_at = NULL,
         completed_at = NULL,
         result = NULL,
         progress_log = NULL
     WHERE id = @id AND status IN ('completed', 'failed')`
  );

  /** Validate sourcePath against the main project worktree (design team's canonical branch). */
  function getValidationWorktree(): string {
    return config.project.path;
  }

  function getBareRepoPath(agentName?: string): string | undefined {
    if (config.server.bareRepoRoot && agentName) {
      return path.join(config.server.bareRepoRoot, `${agentName}.git`);
    }
    return config.server.bareRepoPath;
  }

  interface TaskBody {
    title: string;
    description?: string;
    sourcePath?: string;
    acceptanceCriteria?: string;
    priority?: number;
    files?: string[];
  }

  /** Returns unknown field names from a request body, inferred from a type's keys. */
  function unknownFields<T>(body: unknown, known: { [K in keyof T]: true }): string[] {
    if (typeof body !== 'object' || body === null) return [];
    return Object.keys(body).filter(k => !(k in known));
  }

  const taskBodyKeys: { [K in keyof Required<TaskBody>]: true } = {
    title: true,
    description: true,
    sourcePath: true,
    acceptanceCriteria: true,
    priority: true,
    files: true,
  };

  /** Validate file paths: must be relative, no .., no empty strings. */
  function validateFilePaths(files: string[]): string | null {
    for (const f of files) {
      if (!f || f.startsWith('/') || f.includes('..') || f.trim() === '') {
        return `Invalid file path: '${f}'. Paths must be relative, non-empty, with no '..' components.`;
      }
    }
    return null;
  }

  const insertFile = db.prepare('INSERT OR IGNORE INTO files (path) VALUES (?)');
  const insertTaskFile = db.prepare('INSERT INTO task_files (task_id, file_path) VALUES (?, ?)');
  const getTaskFiles = db.prepare('SELECT file_path FROM task_files WHERE task_id = ?');
  const deleteTaskFiles = db.prepare('DELETE FROM task_files WHERE task_id = ?');

  const claimFilesForAgent = db.prepare(
    `UPDATE files SET claimant = ?, claimed_at = CURRENT_TIMESTAMP
     WHERE path = ? AND claimant IS NULL`
  );

  function checkAndClaimFiles(taskId: number, agent: string): ConflictInfo[] | null {
    const deps = (getTaskFiles.all(taskId) as { file_path: string }[]).map(r => r.file_path);
    if (deps.length === 0) return null;

    const placeholders = deps.map(() => '?').join(', ');
    const conflictRows = db.prepare(
      `SELECT path, claimant FROM files WHERE path IN (${placeholders}) AND claimant IS NOT NULL AND claimant != ?`
    ).all(...deps, agent) as { path: string; claimant: string }[];

    if (conflictRows.length > 0) {
      return conflictRows.map(r => ({ file: r.path, claimant: r.claimant }));
    }

    for (const dep of deps) {
      claimFilesForAgent.run(agent, dep);
    }
    return [];
  }

  function filesForTask(taskId: number): string[] {
    return (getTaskFiles.all(taskId) as { file_path: string }[]).map(r => r.file_path);
  }

  function formatTaskWithFiles(row: TaskRow) {
    return formatTask(row, filesForTask(row.id));
  }

  /** Register files and link them to a task. Must be called within a transaction. */
  function linkFilesToTask(taskId: number, files: string[]): void {
    for (const f of files) {
      insertFile.run(f);
      insertTaskFile.run(taskId, f);
    }
  }

  // POST /tasks
  fastify.post<{ Body: TaskBody }>('/tasks', async (request, reply) => {
    const unknown = unknownFields<TaskBody>(request.body, taskBodyKeys);
    if (unknown.length > 0) {
      return reply.badRequest(
        `Unknown fields: ${unknown.join(', ')}. ` +
        `Valid fields: ${Object.keys(taskBodyKeys).join(', ')}`
      );
    }

    const { title, description, sourcePath, acceptanceCriteria, priority, files } = request.body;

    // Validate sourcePath is committed in the main project worktree
    if (sourcePath) {
      const worktree = getValidationWorktree();
      if (!isCommittedInRepo(worktree, sourcePath)) {
        return reply.unprocessableEntity(
          `sourcePath '${sourcePath}' is not committed in the project worktree (${worktree}). ` +
          `Commit it first: git add ${sourcePath} && git commit`
        );
      }
    }

    // Validate file paths
    if (files?.length) {
      const err = validateFilePaths(files);
      if (err) return reply.badRequest(err);
    }

    const id = db.transaction(() => {
      const result = insertTask.run({
        title,
        description: description ?? '',
        sourcePath: sourcePath ?? null,
        acceptanceCriteria: acceptanceCriteria ?? null,
        priority: priority ?? 0,
      });
      const taskId = Number(result.lastInsertRowid);
      if (files?.length) {
        linkFilesToTask(taskId, files);
      }
      return taskId;
    })();

    return { id, ok: true };
  });

  // POST /tasks/batch — bulk creation
  fastify.post<{
    Body: { tasks: TaskBody[] };
  }>('/tasks/batch', async (request, reply) => {
    const { tasks } = request.body;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return reply.badRequest('tasks must be a non-empty array');
    }

    // Validate all tasks before inserting any
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const extra = unknownFields<TaskBody>(t, taskBodyKeys);
      if (extra.length > 0) {
        return reply.badRequest(
          `Task ${i}: unknown fields: ${extra.join(', ')}. ` +
          `Valid fields: ${Object.keys(taskBodyKeys).join(', ')}`
        );
      }
      if (!t.title) {
        return reply.badRequest(`Task ${i}: title is required`);
      }
      if (t.files?.length) {
        const err = validateFilePaths(t.files);
        if (err) return reply.badRequest(`Task ${i}: ${err}`);
      }
      if (t.sourcePath) {
        const worktree = getValidationWorktree();
        if (!isCommittedInRepo(worktree, t.sourcePath)) {
          return reply.unprocessableEntity(
            `Task ${i}: sourcePath '${t.sourcePath}' is not committed in the project worktree (${worktree}).`
          );
        }
      }
    }

    const ids = db.transaction(() => {
      const result: number[] = [];
      for (const t of tasks) {
        const r = insertTask.run({
          title: t.title,
          description: t.description ?? '',
          sourcePath: t.sourcePath ?? null,
          acceptanceCriteria: t.acceptanceCriteria ?? null,
          priority: t.priority ?? 0,
        });
        const taskId = Number(r.lastInsertRowid);
        if (t.files?.length) {
          linkFilesToTask(taskId, t.files);
        }
        result.push(taskId);
      }
      return result;
    })();

    return { ok: true, ids };
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
    return rows.map(formatTaskWithFiles);
  });

  // GET /tasks/:id
  fastify.get<{
    Params: { id: string };
  }>('/tasks/:id', async (request, reply) => {
    const row = getTaskById.get({ id: Number(request.params.id) }) as TaskRow | undefined;
    if (!row) {
      return reply.notFound('task not found');
    }
    return formatTaskWithFiles(row);
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
      const bareRepo = getBareRepoPath(agent);
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

    let conflicts: ConflictInfo[] | undefined;

    const result = db.transaction(() => {
      const ownershipResult = checkAndClaimFiles(id, agent);
      if (ownershipResult !== null && ownershipResult.length > 0) {
        conflicts = ownershipResult;
        return false;
      }
      const info = claimTask.run({ id, agent });
      return info.changes > 0;
    })();

    if (conflicts && conflicts.length > 0) {
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'File ownership conflict — files are owned by another agent and cannot be claimed until reconciliation',
        conflicts,
      });
    }

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

  // PATCH /tasks/:id — edit a pending task
  fastify.patch<{
    Params: { id: string };
    Body: Partial<TaskBody>;
  }>('/tasks/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const body = request.body;

    const extra = unknownFields<TaskBody>(body, taskBodyKeys);
    if (extra.length > 0) {
      return reply.badRequest(
        `Unknown fields: ${extra.join(', ')}. ` +
        `Valid fields: ${Object.keys(taskBodyKeys).join(', ')}`
      );
    }

    const allowlist: Record<string, string> = {
      title: 'title',
      description: 'description',
      sourcePath: 'source_path',
      acceptanceCriteria: 'acceptance_criteria',
      priority: 'priority',
    };

    const setClauses: string[] = [];
    const params: Record<string, unknown> = { id };

    for (const [camel, snake] of Object.entries(allowlist)) {
      if (camel in body) {
        setClauses.push(`${snake} = @${camel}`);
        params[camel] = (body as Record<string, unknown>)[camel] ?? null;
      }
    }

    const hasFiles = 'files' in body && Array.isArray(body.files);

    if (setClauses.length === 0 && !hasFiles) {
      return reply.badRequest('no updatable fields provided');
    }

    // Validate file paths if provided
    if (hasFiles) {
      const err = validateFilePaths(body.files!);
      if (err) return reply.badRequest(err);
    }

    const row = getTaskById.get({ id }) as TaskRow | undefined;
    if (!row) {
      return reply.notFound('task not found');
    }
    if (row.status !== 'pending') {
      return reply.conflict('task can only be edited when pending');
    }

    if ('sourcePath' in body && typeof body.sourcePath === 'string') {
      const worktree = getValidationWorktree();
      if (!isCommittedInRepo(worktree, body.sourcePath)) {
        return reply.unprocessableEntity(
          `sourcePath '${body.sourcePath}' is not committed in the staging worktree (${worktree}). ` +
          `Commit it first: git add ${body.sourcePath} && git commit`
        );
      }
    }

    const updated = db.transaction(() => {
      if (setClauses.length > 0) {
        const sql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = @id AND status = 'pending'`;
        const info = db.prepare(sql).run(params);
        if (info.changes === 0) return false;
      }
      if (hasFiles) {
        deleteTaskFiles.run(id);
        linkFilesToTask(id, body.files!);
      }
      return true;
    })();

    if (!updated) {
      return reply.conflict('task is no longer pending');
    }
    return { ok: true };
  });

  // POST /tasks/:id/reset — reset a completed/failed task back to pending
  fastify.post<{
    Params: { id: string };
  }>('/tasks/:id/reset', async (request, reply) => {
    const id = Number(request.params.id);

    const row = getTaskById.get({ id }) as TaskRow | undefined;
    if (!row) {
      return reply.notFound('task not found');
    }
    if (row.status !== 'completed' && row.status !== 'failed') {
      return reply.conflict('task can only be reset when completed or failed');
    }

    if (row.source_path) {
      const worktree = getValidationWorktree();
      if (!isCommittedInRepo(worktree, row.source_path)) {
        return reply.unprocessableEntity(
          `sourcePath '${row.source_path}' is no longer committed in the staging worktree`
        );
      }
    }

    const info = resetTask.run({ id });
    if (info.changes === 0) {
      return reply.conflict('task is no longer completed or failed');
    }
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
