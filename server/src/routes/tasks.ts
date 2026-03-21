import type { FastifyPluginAsync } from 'fastify';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { db } from '../db.js';
import type { ScaffoldConfig } from '../config.js';
import { mergeIntoBranch } from '../git-utils.js';

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

export function formatTask(row: TaskRow, files?: string[], dependsOn?: number[], blockedBy?: number[], blockReasons?: string[]) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    sourcePath: row.source_path,
    acceptanceCriteria: row.acceptance_criteria,
    status: row.status,
    priority: row.priority,
    files: files ?? [],
    dependsOn: dependsOn ?? [],
    blockedBy: blockedBy ?? [],
    blockReasons: blockReasons ?? [],
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

/**
 * Write a file to a bare repo using git plumbing (no checkout needed).
 * Returns the commit SHA.
 */
function writeContentToBareRepo(
  bareRepoPath: string,
  branch: string,
  filePath: string,
  content: string,
): string {
  // Step 1: Create blob from content
  const blobSha = spawnSync('git', ['-C', bareRepoPath, 'hash-object', '-w', '--stdin'], {
    input: content,
    encoding: 'utf-8',
    timeout: 10000,
  });
  if (blobSha.status !== 0) throw new Error(`git hash-object failed: ${blobSha.stderr}`);
  const blob = blobSha.stdout.trim();

  // Step 2: Get the current tree for the branch (if branch exists)
  let parentCommit: string | null = null;
  let rootTree: string | null = null;
  try {
    parentCommit = execFileSync('git', ['-C', bareRepoPath, 'rev-parse', `refs/heads/${branch}`], {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
    rootTree = execFileSync('git', ['-C', bareRepoPath, 'rev-parse', `${parentCommit}^{tree}`], {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
  } catch {
    // Branch doesn't exist yet — will create first commit without parent
  }

  // Step 3: Build tree with the new file — handle nested paths
  const parts = filePath.split('/');
  const newRootTree = buildTreeWithFile(bareRepoPath, rootTree, parts, blob);

  // Step 4: Create commit
  const commitArgs = ['-C', bareRepoPath, 'commit-tree', newRootTree, '-m', `Add plan: ${filePath}`];
  if (parentCommit) {
    commitArgs.splice(4, 0, '-p', parentCommit);
  }
  const commitSha = execFileSync('git', commitArgs, {
    encoding: 'utf-8', timeout: 5000,
  }).trim();

  // Step 5: Update branch ref
  execFileSync('git', ['-C', bareRepoPath, 'update-ref', `refs/heads/${branch}`, commitSha], {
    timeout: 5000,
  });

  return commitSha;
}

function buildTreeWithFile(
  bareRepoPath: string,
  currentTreeSha: string | null,
  pathParts: string[],
  blobSha: string,
): string {
  if (pathParts.length === 1) {
    const fileName = pathParts[0];
    const entries: string[] = [];

    if (currentTreeSha) {
      const existing = execFileSync('git', ['-C', bareRepoPath, 'ls-tree', currentTreeSha], {
        encoding: 'utf-8', timeout: 5000,
      });
      for (const line of existing.split('\n').filter(Boolean)) {
        const entryName = line.split('\t')[1];
        if (entryName !== fileName) entries.push(line);
      }
    }

    entries.push(`100644 blob ${blobSha}\t${fileName}`);

    const mkTree = spawnSync('git', ['-C', bareRepoPath, 'mktree'], {
      input: entries.join('\n') + '\n',
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (mkTree.status !== 0) throw new Error(`git mktree failed: ${mkTree.stderr}`);
    return mkTree.stdout.trim();
  }

  const dirName = pathParts[0];
  const remaining = pathParts.slice(1);

  let subtreeSha: string | null = null;
  if (currentTreeSha) {
    try {
      const lsOutput = execFileSync('git', ['-C', bareRepoPath, 'ls-tree', currentTreeSha, '--', dirName], {
        encoding: 'utf-8', timeout: 5000,
      }).trim();
      if (lsOutput) {
        subtreeSha = lsOutput.split(/\s+/)[2];
      }
    } catch { /* directory doesn't exist yet */ }
  }

  const newSubtreeSha = buildTreeWithFile(bareRepoPath, subtreeSha, remaining, blobSha);

  const entries: string[] = [];
  if (currentTreeSha) {
    const existing = execFileSync('git', ['-C', bareRepoPath, 'ls-tree', currentTreeSha], {
      encoding: 'utf-8', timeout: 5000,
    });
    for (const line of existing.split('\n').filter(Boolean)) {
      const entryName = line.split('\t')[1];
      if (entryName !== dirName) entries.push(line);
    }
  }
  entries.push(`040000 tree ${newSubtreeSha}\t${dirName}`);

  const mkTree = spawnSync('git', ['-C', bareRepoPath, 'mktree'], {
    input: entries.join('\n') + '\n',
    encoding: 'utf-8',
    timeout: 5000,
  });
  if (mkTree.status !== 0) throw new Error(`git mktree failed: ${mkTree.stderr}`);
  return mkTree.stdout.trim();
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

  /** True if a string field has a meaningful value (not null, undefined, or empty string). */
  function hasValue(v: string | null | undefined): boolean {
    return v !== null && v !== undefined && v !== '';
  }

  /** Validate sourcePath against the main project worktree (design team's canonical branch). */
  function getValidationWorktree(): string {
    return config.project.path;
  }

  function getBareRepoPath(): string {
    return config.server.bareRepoPath;
  }

  interface TaskBody {
    title: string;
    description?: string;
    sourcePath?: string;
    sourceContent?: string;
    acceptanceCriteria?: string;
    priority?: number;
    files?: string[];
    targetAgents?: string[] | string;
    dependsOn?: number[];
    dependsOnIndex?: number[];
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
    sourceContent: true,
    acceptanceCriteria: true,
    priority: true,
    files: true,
    targetAgents: true,
    dependsOn: true,
    dependsOnIndex: true,
  };

  type PatchBody = Omit<TaskBody, 'sourceContent' | 'targetAgents' | 'dependsOnIndex'>;
  const patchBodyKeys: { [K in keyof Required<PatchBody>]: true } = {
    title: true,
    description: true,
    sourcePath: true,
    acceptanceCriteria: true,
    priority: true,
    files: true,
    dependsOn: true,
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

  const insertDep = db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on) VALUES (?, ?)');
  const getDepsForTask = db.prepare('SELECT depends_on FROM task_dependencies WHERE task_id = ?');
  const getBlockersForTask = db.prepare(`
    SELECT d.depends_on FROM task_dependencies d
    JOIN tasks dep ON dep.id = d.depends_on
    WHERE d.task_id = ? AND dep.status != 'completed'
  `);
  const deleteDepsForTask = db.prepare('DELETE FROM task_dependencies WHERE task_id = ?');

  function depsForTask(taskId: number): number[] {
    return (getDepsForTask.all(taskId) as { depends_on: number }[]).map(r => r.depends_on);
  }
  function blockersForTask(taskId: number): number[] {
    return (getBlockersForTask.all(taskId) as { depends_on: number }[]).map(r => r.depends_on);
  }
  function linkDepsToTask(taskId: number, depIds: number[]): void {
    for (const depId of depIds) insertDep.run(taskId, depId);
  }

  const claimFilesForAgent = db.prepare(
    `UPDATE files SET claimant = ?, claimed_at = CURRENT_TIMESTAMP
     WHERE path = ? AND claimant IS NULL`
  );

  const getFileConflicts = db.prepare(
    `SELECT f.path, f.claimant FROM task_files tf
     JOIN files f ON f.path = tf.file_path
     WHERE tf.task_id = ? AND f.claimant IS NOT NULL AND f.claimant != ?`
  );

  // NOTE: This query returns ALL file locks, not filtered by requesting agent.
  // For pending tasks this is correct since pending tasks cannot hold file locks.
  // If a task is released back to pending while the agent still holds files,
  // the block reason may incorrectly include the original agent's locks.
  const getFileConflictsForTask = db.prepare(
    `SELECT f.path, f.claimant FROM task_files tf
     JOIN files f ON f.path = tf.file_path
     WHERE tf.task_id = ? AND f.claimant IS NOT NULL`
  );

  function checkAndClaimFiles(taskId: number, agent: string): ConflictInfo[] | null {
    const deps = (getTaskFiles.all(taskId) as { file_path: string }[]).map(r => r.file_path);
    if (deps.length === 0) return null;

    const conflictRows = getFileConflicts.all(taskId, agent) as { path: string; claimant: string }[];

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

  function blockReasonsForTask(row: TaskRow): string[] {
    if (row.status !== 'pending') return [];
    const reasons: string[] = [];

    // Missing sourcePath check
    if (row.source_path) {
      const bareRepo = config.server.bareRepoPath;
      if (bareRepo) {
        const planBranch = config.tasks?.planBranch ?? 'docker/current-root';
        // NOTE: existsInBareRepo runs git cat-file synchronously per pending task.
        // For large queues (50+ pending tasks with sourcePaths), this could cause
        // latency spikes. Consider batch validation or caching if this becomes
        // a bottleneck in practice.
        if (!existsInBareRepo(bareRepo, planBranch, row.source_path)) {
          reasons.push(`sourcePath '${row.source_path}' not found on ${planBranch}`);
        }
      }
    }

    // File-lock conflicts
    const conflicts = getFileConflictsForTask.all(row.id) as { path: string; claimant: string }[];
    if (conflicts.length > 0) {
      const byClaimant = new Map<string, string[]>();
      for (const c of conflicts) {
        const list = byClaimant.get(c.claimant) ?? [];
        list.push(c.path);
        byClaimant.set(c.claimant, list);
      }
      for (const [claimant, paths] of byClaimant) {
        reasons.push(`files locked by agent '${claimant}': ${paths.join(', ')}`);
      }
    }

    // Unmet dependencies
    const blockers = blockersForTask(row.id);
    if (blockers.length > 0) {
      reasons.push(`blocked by incomplete task(s): #${blockers.join(', #')}`);
    }

    return reasons;
  }

  function formatTaskWithFiles(row: TaskRow) {
    const reasons = blockReasonsForTask(row);
    return formatTask(row, filesForTask(row.id), depsForTask(row.id), blockersForTask(row.id), reasons);
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

    const { title, description, sourcePath, sourceContent, acceptanceCriteria, priority, files, targetAgents, dependsOn, dependsOnIndex } = request.body;

    let commitSha: string | undefined;

    // Validate sourcePath for path traversal before any git operations
    if (sourcePath !== undefined && sourcePath !== null) {
      if (typeof sourcePath === 'string' && (sourcePath.includes('..') || sourcePath.startsWith('/') || sourcePath === '')) {
        return reply.badRequest(`Invalid sourcePath: ${sourcePath}`);
      }
    }

    // Tasks are a union: EITHER sourcePath (plan mode) OR description/acceptanceCriteria (inline mode).
    // Mixed-protocol requests are rejected to prevent ambiguous task definitions.
    if (hasValue(sourcePath) && (hasValue(description) || hasValue(acceptanceCriteria))) {
      return reply.badRequest(
        'Mixed task protocol: a task must use EITHER sourcePath (plan mode) OR description/acceptanceCriteria (inline mode), not both. ' +
        'Plan-mode tasks read their full specification from the sourcePath file. ' +
        'Inline tasks carry their specification in description + acceptanceCriteria fields.'
      );
    }

    // B1: targetAgents requires sourceContent (merge needs a commit to propagate)
    if (targetAgents && !sourceContent) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'targetAgents requires sourceContent',
      });
    }

    // N1: Validate targetAgents shape before any git writes
    if (targetAgents && targetAgents !== '*' && !Array.isArray(targetAgents)) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'targetAgents must be an array of agent names or "*"',
      });
    }

    if (sourceContent) {
      if (!sourcePath) {
        return reply.badRequest('sourceContent requires sourcePath');
      }
      const bareRepo = config.server.bareRepoPath;
      if (!bareRepo) {
        return reply.code(422).send({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: 'sourceContent requires server.bareRepoPath to be configured',
        });
      }
      const planBranch = config.tasks?.planBranch ?? 'docker/current-root';
      try {
        commitSha = writeContentToBareRepo(bareRepo, planBranch, sourcePath, sourceContent);
      } catch (err: any) {
        return reply.code(422).send({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: `Failed to write plan to bare repo: ${err.message}`,
        });
      }
    } else if (sourcePath) {
      const bareRepo = config.server.bareRepoPath;
      if (bareRepo) {
        const planBranch = config.tasks?.planBranch ?? 'docker/current-root';
        if (!existsInBareRepo(bareRepo, planBranch, sourcePath)) {
          return reply.code(422).send({
            statusCode: 422,
            error: 'Unprocessable Entity',
            message: `sourcePath '${sourcePath}' not found on branch '${planBranch}' in bare repo`,
          });
        }
      } else {
        const worktree = getValidationWorktree();
        if (!isCommittedInRepo(worktree, sourcePath)) {
          return reply.unprocessableEntity(
            `sourcePath '${sourcePath}' is not committed in the project worktree (${worktree}). ` +
            `Commit it first: git add ${sourcePath} && git commit`
          );
        }
      }
    }

    // Validate file paths
    if (files?.length) {
      const err = validateFilePaths(files);
      if (err) return reply.badRequest(err);
    }

    // Reject dependsOnIndex in single create
    if (dependsOnIndex?.length) {
      return reply.badRequest('dependsOnIndex is only valid in POST /tasks/batch');
    }

    // Validate dependsOn
    if (dependsOn?.length) {
      for (const depId of dependsOn) {
        if (typeof depId !== 'number' || depId <= 0 || !Number.isInteger(depId)) {
          return reply.badRequest(`Invalid dependency ID: ${depId}`);
        }
        const dep = getTaskById.get({ id: depId }) as TaskRow | undefined;
        if (!dep) {
          return reply.badRequest(`Dependency task ${depId} does not exist`);
        }
      }
    }

    // Merge into agent branches if requested
    let mergedAgents: string[] = [];
    let failedMerges: Array<{ agent: string; reason: string }> = [];

    if (targetAgents && commitSha) {
      let agentNames: string[];
      if (targetAgents === '*') {
        const activeAgents = db.prepare(
          "SELECT name FROM agents WHERE status NOT IN ('done', 'error')"
        ).all() as Array<{ name: string }>;
        agentNames = activeAgents.map(a => a.name);
      } else {
        agentNames = targetAgents as string[];
      }

      const bareRepo = getBareRepoPath();
      if (!bareRepo) {
        fastify.log.warn('targetAgents requested but bareRepoPath is not configured');
      } else {
        const planBranch = config.tasks?.planBranch ?? 'docker/current-root';

        for (const agentName of agentNames) {
          const targetBranch = `docker/${agentName}`;
          const result = mergeIntoBranch(bareRepo, planBranch, targetBranch);
          if (result.ok) {
            mergedAgents.push(agentName);
          } else {
            failedMerges.push({ agent: agentName, reason: result.reason });
            fastify.log.warn(`Failed to merge ${planBranch} into ${targetBranch}: ${result.reason}`);
          }
        }
      }
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
      if (dependsOn?.length) {
        linkDepsToTask(taskId, dependsOn);
      }
      return taskId;
    })();

    return {
      id,
      ok: true,
      ...(commitSha ? { commitSha } : {}),
      ...(mergedAgents.length ? { mergedAgents } : {}),
      ...(failedMerges.length ? { failedMerges } : {}),
    };
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
      // Validate sourcePath for path traversal
      if (t.sourcePath !== undefined && t.sourcePath !== null) {
        if (typeof t.sourcePath === 'string' && (t.sourcePath.includes('..') || t.sourcePath.startsWith('/') || t.sourcePath === '')) {
          return reply.badRequest(`Task ${i}: Invalid sourcePath: ${t.sourcePath}`);
        }
      }
      // Mixed-protocol check
      if (hasValue(t.sourcePath) && (hasValue(t.description) || hasValue(t.acceptanceCriteria))) {
        return reply.badRequest(
          `Task ${i}: Mixed task protocol: use EITHER sourcePath (plan mode) OR description/acceptanceCriteria (inline mode), not both.`
        );
      }
      // Validate dependsOnIndex
      if (t.dependsOnIndex?.length) {
        for (const idx of t.dependsOnIndex) {
          if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= tasks.length) {
            return reply.badRequest(`Task ${i}: invalid dependsOnIndex value ${idx}`);
          }
          if (idx === i) {
            return reply.badRequest(`Task ${i}: dependsOnIndex cannot reference self`);
          }
        }
      }
      // Validate dependsOn (pre-existing IDs)
      if (t.dependsOn?.length) {
        for (const depId of t.dependsOn) {
          if (typeof depId !== 'number' || depId <= 0 || !Number.isInteger(depId)) {
            return reply.badRequest(`Task ${i}: Invalid dependency ID: ${depId}`);
          }
          const dep = getTaskById.get({ id: depId }) as TaskRow | undefined;
          if (!dep) {
            return reply.badRequest(`Task ${i}: Dependency task ${depId} does not exist`);
          }
        }
      }
      if (t.sourceContent && !t.sourcePath) {
        return reply.badRequest(`Task ${i}: sourceContent requires sourcePath`);
      }
      if (t.sourceContent) {
        const bareRepo = config.server.bareRepoPath;
        if (!bareRepo) {
          return reply.code(422).send({
            statusCode: 422,
            error: 'Unprocessable Entity',
            message: `Task ${i}: sourceContent requires server.bareRepoPath to be configured`,
          });
        }
      } else if (t.sourcePath) {
        const bareRepo = config.server.bareRepoPath;
        if (bareRepo) {
          const planBranch = config.tasks?.planBranch ?? 'docker/current-root';
          if (!existsInBareRepo(bareRepo, planBranch, t.sourcePath)) {
            return reply.code(422).send({
              statusCode: 422,
              error: 'Unprocessable Entity',
              message: `Task ${i}: sourcePath '${t.sourcePath}' not found on branch '${planBranch}' in bare repo`,
            });
          }
        } else {
          const worktree = getValidationWorktree();
          if (!isCommittedInRepo(worktree, t.sourcePath)) {
            return reply.unprocessableEntity(
              `Task ${i}: sourcePath '${t.sourcePath}' is not committed in the project worktree (${worktree}).`
            );
          }
        }
      }
    }

    // Intra-batch cycle detection: check for mutual dependsOnIndex references.
    // Only direct mutual cycles (A<->B) are detected; longer cycles (A->B->C->A) are not checked.
    for (let i = 0; i < tasks.length; i++) {
      if (tasks[i].dependsOnIndex?.length) {
        for (const idx of tasks[i].dependsOnIndex!) {
          if (tasks[idx].dependsOnIndex?.includes(i)) {
            return reply.badRequest(`Cycle detected: task ${i} and task ${idx} depend on each other`);
          }
        }
      }
    }

    // Write sourceContent for tasks that have it
    const commitShas: Record<number, string> = {};
    const bareRepo = config.server.bareRepoPath;
    const planBranch = config.tasks?.planBranch ?? 'docker/current-root';
    const tasksWithContent = tasks.filter((t, _i) => t.sourceContent && t.sourcePath && bareRepo);

    // Capture pre-batch ref for rollback if DB transaction fails
    let preBatchRef: string | undefined;
    if (bareRepo && tasksWithContent.length > 0) {
      try {
        preBatchRef = execFileSync('git', ['-C', bareRepo, 'rev-parse', `refs/heads/${planBranch}`], {
          encoding: 'utf-8', timeout: 5000,
        }).trim();
      } catch { /* branch doesn't exist yet */ }
    }

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (t.sourceContent && t.sourcePath && bareRepo) {
        try {
          commitShas[i] = writeContentToBareRepo(bareRepo, planBranch, t.sourcePath, t.sourceContent);
        } catch (err: any) {
          return reply.code(422).send({
            statusCode: 422,
            error: 'Unprocessable Entity',
            message: `Task ${i}: Failed to write plan to bare repo: ${err.message}`,
          });
        }
      }
    }

    let ids: number[];
    try {
      ids = db.transaction(() => {
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
          if (t.dependsOn?.length) {
            linkDepsToTask(taskId, t.dependsOn);
          }
          result.push(taskId);
        }
        return result;
      })();
    } catch (err) {
      // Roll back git writes
      if (preBatchRef && bareRepo) {
        try {
          execFileSync('git', ['-C', bareRepo, 'update-ref', `refs/heads/${planBranch}`, preBatchRef], { timeout: 5000 });
        } catch { /* best effort */ }
      }
      throw err;
    }

    // Resolve dependsOnIndex cross-references
    // Mixed dependsOn + dependsOnIndex is permitted on the same task.
    // INSERT OR IGNORE silently deduplicates if both reference the same resolved ID.
    const hasDependsOnIndex = tasks.some(t => t.dependsOnIndex?.length);
    if (hasDependsOnIndex) {
      db.transaction(() => {
        for (let i = 0; i < tasks.length; i++) {
          if (tasks[i].dependsOnIndex?.length) {
            for (const idx of tasks[i].dependsOnIndex!) {
              insertDep.run(ids[i], ids[idx]);
            }
          }
        }
      })();
    }

    // Build positionally aligned commitShas array
    const hasAnyShas = Object.keys(commitShas).length > 0;
    const commitShasArray = hasAnyShas ? ids.map((_id, i) => commitShas[i] ?? null) : undefined;
    return { ok: true, ids, ...(commitShasArray ? { commitShas: commitShasArray } : {}) };
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

  // POST /tasks/claim-next — atomically find and claim the best available task
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
        WHERE d.task_id = t.id AND dep.status != 'completed'
      )
    GROUP BY t.id
    ORDER BY new_locks ASC, t.priority DESC, t.id ASC
    LIMIT 1
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
        WHERE d.task_id = t.id AND dep.status != 'completed'
      )
  `);

  fastify.post('/tasks/claim-next', async (request) => {
    const agent = (request.headers['x-agent-name'] as string) ?? 'unknown';

    const result = db.transaction(() => {
      const candidate = claimNextCandidate.get(agent) as
        | { id: number; new_locks: number }
        | undefined;

      if (!candidate) {
        const { count: pendingCount } = countPending.get() as { count: number };
        if (pendingCount === 0) {
          return { task: null, pending: 0, blocked: 0 };
        }
        // Note: blocked (file-conflict) and depBlocked (dependency) counts may overlap —
        // a single task can be blocked by both reasons. Both fields are kept for diagnostic value.
        const { count: blockedCount } = countBlocked.get(agent) as { count: number };
        const { count: depBlockedCount } = countDepBlocked.get() as { count: number };
        return {
          task: null,
          pending: pendingCount,
          blocked: blockedCount,
          depBlocked: depBlockedCount,
          reason: 'all pending tasks have file conflicts or unmet dependencies',
        };
      }

      // Claim the task
      claimTask.run({ id: candidate.id, agent });

      // Claim its files
      const deps = (getTaskFiles.all(candidate.id) as { file_path: string }[])
        .map(r => r.file_path);
      for (const dep of deps) {
        claimFilesForAgent.run(agent, dep);
      }

      const row = getTaskById.get({ id: candidate.id }) as TaskRow;
      return { task: formatTaskWithFiles(row) };
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

    const blockers = blockersForTask(id);
    if (blockers.length > 0) {
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'Task has unmet dependencies',
        blockedBy: blockers,
      });
    }

    const result = db.transaction(() => {
      const ownershipResult = checkAndClaimFiles(id, agent);
      if (ownershipResult !== null && ownershipResult.length > 0) {
        return { ok: false as const, conflicts: ownershipResult };
      }
      const info = claimTask.run({ id, agent });
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

    const extra = unknownFields<PatchBody>(body, patchBodyKeys);
    if (extra.length > 0) {
      return reply.badRequest(
        `Unknown fields: ${extra.join(', ')}. ` +
        `Valid fields: ${Object.keys(patchBodyKeys).join(', ')}`
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
    const hasDeps = 'dependsOn' in body && Array.isArray(body.dependsOn);

    if (setClauses.length === 0 && !hasFiles && !hasDeps) {
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

    // Mixed-protocol check: evaluate resulting state (existing row + patch)
    const resultSourcePath = 'sourcePath' in body ? body.sourcePath : row.source_path;
    const resultDesc = 'description' in body ? body.description : row.description;
    const resultAC = 'acceptanceCriteria' in body ? body.acceptanceCriteria : row.acceptance_criteria;
    if (hasValue(resultSourcePath) && (hasValue(resultDesc) || hasValue(resultAC))) {
      return reply.badRequest(
        'Mixed task protocol: a task must use EITHER sourcePath (plan mode) OR description/acceptanceCriteria (inline mode), not both. ' +
        'To switch modes, set the other fields to null.'
      );
    }

    // Validate dependsOn IDs if provided
    if (hasDeps) {
      for (const depId of body.dependsOn!) {
        if (typeof depId !== 'number' || depId <= 0 || !Number.isInteger(depId)) {
          return reply.badRequest(`Invalid dependency ID: ${depId}`);
        }
        if (depId === id) {
          return reply.badRequest('Task cannot depend on itself');
        }
        const dep = getTaskById.get({ id: depId }) as TaskRow | undefined;
        if (!dep) {
          return reply.badRequest(`Dependency task ${depId} does not exist`);
        }
        // Only direct mutual cycles (A↔B) are detected; longer cycles (A→B→C→A) are not checked.
        const existingDepsOfDep = depsForTask(depId);
        if (existingDepsOfDep.includes(id)) {
          return reply.badRequest(`Cycle detected: task ${id} and task ${depId} depend on each other`);
        }
      }
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
      if (hasDeps) {
        deleteDepsForTask.run(id);
        linkDepsToTask(id, body.dependsOn!);
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
