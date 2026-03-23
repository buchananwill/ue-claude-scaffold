import type { FastifyPluginAsync } from 'fastify';
import { execFileSync } from 'node:child_process';
import { db } from '../db.js';
import type { ScaffoldConfig } from '../config.js';
import { mergeIntoBranch, writeContentToBareRepo, isCommittedInRepo, existsInBareRepo } from '../git-utils.js';
import { formatTask, type TaskRow } from './tasks-types.js';
import { initTasksSharedStatements, type TasksOpts, type TaskBody, type PatchBody, type TasksSharedStatements } from './tasks-files.js';
import { taskBodyKeys, patchBodyKeys } from './tasks-files.js';
import { runReplan } from './tasks-replan.js';
import tasksReplanPlugin from './tasks-replan.js';
import tasksClaimPlugin from './tasks-claim.js';
import tasksLifecyclePlugin from './tasks-lifecycle.js';

export { formatTask, type TaskRow } from './tasks-types.js';

const tasksPlugin: FastifyPluginAsync<TasksOpts> = async (fastify, opts) => {
  const config = opts.config;

  const shared = initTasksSharedStatements(config);

  await fastify.register(tasksReplanPlugin, { config });
  await fastify.register(tasksClaimPlugin, { config, shared });
  await fastify.register(tasksLifecyclePlugin, { config, shared });

  const {
    insertTask,
    getTaskById,
    deleteTaskFiles,
    deleteDepsForTask,
    deleteTask,
    insertDep,
    hasValue,
    getValidationWorktree,
    getBareRepoPath,
    validateFilePaths,
    unknownFields,
    linkFilesToTask,
    linkDepsToTask,
    filesForTask,
    depsForTask,
    formatTaskWithFiles,
  } = shared;

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
    Querystring: { replan?: string };
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
    const base = { ok: true as const, ids, ...(commitShasArray ? { commitShas: commitShasArray } : {}) };
    if (request.query.replan === 'true') {
      return { ...base, replan: runReplan() };
    }
    return base;
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
    const agent = (request.headers['x-agent-name'] as string) ?? 'unknown';
    return rows.map(r => formatTaskWithFiles(r, agent));
  });

  // GET /tasks/:id
  fastify.get<{
    Params: { id: string };
  }>('/tasks/:id', async (request, reply) => {
    const row = getTaskById.get({ id: Number(request.params.id) }) as TaskRow | undefined;
    if (!row) {
      return reply.notFound('task not found');
    }
    const agent = (request.headers['x-agent-name'] as string) ?? 'unknown';
    return formatTaskWithFiles(row, agent);
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

    if ('priority' in body) {
      setClauses.push('base_priority = @priority');
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
        // Only direct mutual cycles (A<->B) are detected; longer cycles (A->B->C->A) are not checked.
        const existingDepsOfDep = depsForTask(depId);
        if (existingDepsOfDep.includes(id)) {
          return reply.badRequest(`Cycle detected: task ${id} and task ${depId} depend on each other`);
        }
      }
    }

    if ('sourcePath' in body && typeof body.sourcePath === 'string') {
      const bareRepo = getBareRepoPath();
      if (bareRepo) {
        const planBranch = config.tasks?.planBranch ?? 'docker/current-root';
        if (!existsInBareRepo(bareRepo, planBranch, body.sourcePath)) {
          return reply.unprocessableEntity(
            `sourcePath '${body.sourcePath}' not found on branch '${planBranch}' in bare repo`
          );
        }
      } else {
        const worktree = getValidationWorktree();
        if (!isCommittedInRepo(worktree, body.sourcePath)) {
          return reply.unprocessableEntity(
            `sourcePath '${body.sourcePath}' is not committed in the staging worktree (${worktree}). ` +
            `Commit it first: git add ${body.sourcePath} && git commit`
          );
        }
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

  // DELETE /tasks/:id — delete a single task
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
