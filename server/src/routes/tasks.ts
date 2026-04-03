import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as tasksCore from '../queries/tasks-core.js';
import * as taskFilesQ from '../queries/task-files.js';
import * as taskDepsQ from '../queries/task-deps.js';
import * as compositionQ from '../queries/composition.js';
import * as agentsQ from '../queries/agents.js';
import * as projectsQ from '../queries/projects.js';
import type { ScaffoldConfig } from '../config.js';
import { getProject } from '../config.js';
import { mergeIntoBranch, isCommittedInRepo, existsInBareRepo, syncExteriorToBareRepo } from '../git-utils.js';
import { seedBranchFor, agentBranchFor } from '../branch-naming.js';
import { formatTask, type TaskRow } from './tasks-types.js';
import {
  type TasksOpts, type TaskBody, type PatchBody,
  taskBodyKeys, patchBodyKeys,
  hasValue, validateFilePaths, unknownFields,
  linkFilesToTask, linkDepsToTask, depsForTask,
  formatTaskWithFiles,
} from './tasks-files.js';
import { runReplan } from './tasks-replan.js';
import tasksReplanPlugin from './tasks-replan.js';
import tasksClaimPlugin from './tasks-claim.js';
import tasksLifecyclePlugin from './tasks-lifecycle.js';

export { formatTask, type TaskRow } from './tasks-types.js';

const tasksPlugin: FastifyPluginAsync<TasksOpts> = async (fastify, opts) => {
  const config = opts.config;

  await fastify.register(tasksReplanPlugin, { config });
  await fastify.register(tasksClaimPlugin, { config });
  await fastify.register(tasksLifecyclePlugin, { config });

  // POST /tasks
  fastify.post<{ Body: TaskBody }>('/tasks', async (request, reply) => {
    const projectId = request.projectId;
    const unknown = unknownFields<TaskBody>(request.body, taskBodyKeys);
    if (unknown.length > 0) {
      return reply.badRequest(
        `Unknown fields: ${unknown.join(', ')}. ` +
        `Valid fields: ${Object.keys(taskBodyKeys).join(', ')}`
      );
    }

    const { title, description, sourcePath, acceptanceCriteria, priority, files, targetAgents, dependsOn, dependsOnIndex } = request.body;

    // Validate sourcePath for path traversal before any git operations
    if (sourcePath !== undefined && sourcePath !== null) {
      if (typeof sourcePath === 'string' && (sourcePath.includes('..') || sourcePath.startsWith('/') || sourcePath === '')) {
        return reply.badRequest(`Invalid sourcePath: ${sourcePath}`);
      }
    }

    // Tasks are a union: EITHER sourcePath (plan mode) OR description/acceptanceCriteria (inline mode).
    if (hasValue(sourcePath) && (hasValue(description) || hasValue(acceptanceCriteria))) {
      return reply.badRequest(
        'Mixed task protocol: a task must use EITHER sourcePath (plan mode) OR description/acceptanceCriteria (inline mode), not both. ' +
        'Plan-mode tasks read their full specification from the sourcePath file. ' +
        'Inline tasks carry their specification in description + acceptanceCriteria fields.'
      );
    }

    // Validate targetAgents shape
    if (targetAgents && targetAgents !== '*' && !Array.isArray(targetAgents)) {
      return reply.badRequest('targetAgents must be an array of agent names or "*"');
    }

    // Validate sourcePath exists — auto-sync from exterior repo if not found in bare repo
    if (sourcePath) {
      let project;
      try {
        const spDbRow = await projectsQ.getById(getDb(), projectId);
        project = getProject(config, projectId, spDbRow ?? undefined);
      } catch {
        return reply.badRequest(`Unknown project: "${projectId}"`);
      }
      const bareRepo = project.bareRepoPath;
      if (bareRepo) {
        const seedBranch = seedBranchFor(projectId, project);
        if (!existsInBareRepo(bareRepo, seedBranch, sourcePath)) {
          // Auto-sync from exterior repo before rejecting
          const exteriorRepo = project.path;
          if (exteriorRepo) {
            syncExteriorToBareRepo(exteriorRepo, bareRepo, seedBranch, fastify.log);
          }
          // Re-check after sync
          if (!existsInBareRepo(bareRepo, seedBranch, sourcePath)) {
            return reply.code(422).send({
              statusCode: 422,
              error: 'Unprocessable Entity',
              message: `sourcePath '${sourcePath}' not found on branch '${seedBranch}' in bare repo. ` +
                `Commit the plan in the exterior repo and retry.`,
            });
          }
        }
      } else {
        const worktree = project.path;
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
    const db = getDb();
    if (dependsOn?.length) {
      for (const depId of dependsOn) {
        if (typeof depId !== 'number' || depId <= 0 || !Number.isInteger(depId)) {
          return reply.badRequest(`Invalid dependency ID: ${depId}`);
        }
        const dep = await tasksCore.getById(db, depId);
        if (!dep) {
          return reply.badRequest(`Dependency task ${depId} does not exist`);
        }
      }
    }

    // Merge seed branch into agent branches if requested
    const mergedAgents: string[] = [];
    const failedMerges: Array<{ agent: string; reason: string }> = [];

    if (targetAgents) {
      let agentNames: string[];
      if (targetAgents === '*') {
        agentNames = await agentsQ.getActiveNames(db);
      } else {
        agentNames = targetAgents as string[];
      }

      // Validate agent names unconditionally (before any git operations)
      for (const agentName of agentNames) {
        if (typeof agentName !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(agentName)) {
          return reply.badRequest(`Invalid agent name in targetAgents: "${String(agentName).slice(0, 64)}"`);
        }
      }

      let mergeProject;
      try {
        const dbRow = await projectsQ.getById(db, projectId);
        mergeProject = getProject(config, projectId, dbRow ?? undefined);
      } catch {
        return reply.badRequest(`Unknown project: "${projectId}"`);
      }
      const bareRepo = mergeProject.bareRepoPath;
      if (!bareRepo) {
        fastify.log.warn('targetAgents requested but bareRepoPath is not configured');
      } else {
        const seedBranch = seedBranchFor(projectId, mergeProject);

        for (const agentName of agentNames) {
          const targetBranch = agentBranchFor(projectId, agentName);
          const result = mergeIntoBranch(bareRepo, seedBranch, targetBranch);
          if (result.ok) {
            mergedAgents.push(agentName);
          } else {
            failedMerges.push({ agent: agentName, reason: result.reason });
            fastify.log.warn(`Failed to merge ${seedBranch} into ${targetBranch}: ${result.reason}`);
          }
        }
      }
    }

    const inserted = await tasksCore.insert(db, {
      title,
      description: description ?? '',
      sourcePath: sourcePath ?? undefined,
      acceptanceCriteria: acceptanceCriteria ?? undefined,
      priority: priority ?? 0,
      projectId,
    });
    const id = inserted.id;
    if (files?.length) {
      await linkFilesToTask(id, files, projectId);
    }
    if (dependsOn?.length) {
      await linkDepsToTask(id, dependsOn);
    }

    return {
      id,
      ok: true,
      ...(mergedAgents.length ? { mergedAgents } : {}),
      ...(failedMerges.length ? { failedMerges } : {}),
    };
  });

  // POST /tasks/batch — bulk creation
  fastify.post<{
    Body: { tasks: TaskBody[] };
    Querystring: { replan?: string };
  }>('/tasks/batch', async (request, reply) => {
    const projectId = request.projectId;
    const { tasks } = request.body;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return reply.badRequest('tasks must be a non-empty array');
    }

    // Track whether we've already attempted auto-sync for this batch
    let batchSynced = false;
    const db = getDb();

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
          const dep = await tasksCore.getById(db, depId);
          if (!dep) {
            return reply.badRequest(`Task ${i}: Dependency task ${depId} does not exist`);
          }
        }
      }
      if (t.sourcePath) {
        let project;
        try {
          const dbRow = await projectsQ.getById(db, projectId);
          project = getProject(config, projectId, dbRow ?? undefined);
        } catch {
          return reply.badRequest(`Unknown project: "${projectId}"`);
        }
        const bareRepo = project.bareRepoPath;
        if (bareRepo) {
          const seedBranch = seedBranchFor(projectId, project);
          if (!existsInBareRepo(bareRepo, seedBranch, t.sourcePath)) {
            // Auto-sync from exterior repo on first miss (once per batch)
            if (!batchSynced) {
              const exteriorRepo = project.path;
              if (exteriorRepo) {
                syncExteriorToBareRepo(exteriorRepo, bareRepo, seedBranch, fastify.log);
              }
              batchSynced = true;
            }
            // Re-check after sync
            if (!existsInBareRepo(bareRepo, seedBranch, t.sourcePath)) {
              return reply.code(422).send({
                statusCode: 422,
                error: 'Unprocessable Entity',
                message: `Task ${i}: sourcePath '${t.sourcePath}' not found on branch '${seedBranch}' in bare repo. ` +
                  `Commit the plan in the exterior repo and retry.`,
              });
            }
          }
        } else {
          const worktree = project.path;
          if (!isCommittedInRepo(worktree, t.sourcePath)) {
            return reply.unprocessableEntity(
              `Task ${i}: sourcePath '${t.sourcePath}' is not committed in the project worktree (${worktree}).`
            );
          }
        }
      }
    }

    // Intra-batch cycle detection
    for (let i = 0; i < tasks.length; i++) {
      if (tasks[i].dependsOnIndex?.length) {
        for (const idx of tasks[i].dependsOnIndex!) {
          if (tasks[idx].dependsOnIndex?.includes(i)) {
            return reply.badRequest(`Cycle detected: task ${i} and task ${idx} depend on each other`);
          }
        }
      }
    }

    const ids: number[] = [];
    for (const t of tasks) {
      const inserted = await tasksCore.insert(db, {
        title: t.title,
        description: t.description ?? '',
        sourcePath: t.sourcePath ?? undefined,
        acceptanceCriteria: t.acceptanceCriteria ?? undefined,
        priority: t.priority ?? 0,
        projectId,
      });
      const taskId = inserted.id;
      if (t.files?.length) {
        await linkFilesToTask(taskId, t.files, projectId);
      }
      if (t.dependsOn?.length) {
        await linkDepsToTask(taskId, t.dependsOn);
      }
      ids.push(taskId);
    }

    // Resolve dependsOnIndex cross-references
    const hasDependsOnIndex = tasks.some(t => t.dependsOnIndex?.length);
    if (hasDependsOnIndex) {
      for (let i = 0; i < tasks.length; i++) {
        if (tasks[i].dependsOnIndex?.length) {
          for (const idx of tasks[i].dependsOnIndex!) {
            await taskDepsQ.insertDep(db, ids[i], ids[idx]);
          }
        }
      }
    }

    const base = { ok: true as const, ids };
    if (request.query.replan === 'true') {
      return { ...base, replan: await runReplan() };
    }
    return base;
  });

  // GET /tasks
  fastify.get<{
    Querystring: { status?: string; limit?: string; offset?: string; project?: string };
  }>('/tasks', async (request) => {
    const { status, limit, offset, project } = request.query;
    const projectId = project || request.projectId;
    const limitNum = Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : 20);
    const offsetNum = Math.max(0, Number.isFinite(Number(offset)) ? Number(offset) : 0);

    const db = getDb();
    const rows = await tasksCore.list(db, { status, projectId, limit: limitNum, offset: offsetNum });
    const total = await tasksCore.count(db, { status, projectId });
    const agent = (request.headers['x-agent-name'] as string) ?? 'unknown';

    const formattedTasks = await Promise.all(
      rows.map(r => formatTaskWithFiles(r as unknown as TaskRow, agent, config))
    );
    return { tasks: formattedTasks, total };
  });

  // GET /tasks/:id
  fastify.get<{
    Params: { id: string };
  }>('/tasks/:id', async (request, reply) => {
    const db = getDb();
    const row = await tasksCore.getById(db, Number(request.params.id));
    if (!row) {
      return reply.notFound('task not found');
    }
    const agent = (request.headers['x-agent-name'] as string) ?? 'unknown';
    return formatTaskWithFiles(row as unknown as TaskRow, agent, config);
  });

  // PATCH /tasks/:id — edit a pending task
  fastify.patch<{
    Params: { id: string };
    Body: Partial<TaskBody>;
  }>('/tasks/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const body = request.body;
    const db = getDb();

    const extra = unknownFields<PatchBody>(body, patchBodyKeys);
    if (extra.length > 0) {
      return reply.badRequest(
        `Unknown fields: ${extra.join(', ')}. ` +
        `Valid fields: ${Object.keys(patchBodyKeys).join(', ')}`
      );
    }

    const hasFiles = 'files' in body && Array.isArray(body.files);
    const hasDeps = 'dependsOn' in body && Array.isArray(body.dependsOn);

    // Build the patch fields
    const patchFields: tasksCore.PatchFields = {};
    if ('title' in body) patchFields.title = body.title as string;
    if ('description' in body) patchFields.description = body.description as string;
    if ('sourcePath' in body) patchFields.sourcePath = body.sourcePath as string;
    if ('acceptanceCriteria' in body) patchFields.acceptanceCriteria = body.acceptanceCriteria as string;
    if ('priority' in body) patchFields.priority = body.priority as number;

    const hasScalarFields = Object.keys(patchFields).length > 0;

    if (!hasScalarFields && !hasFiles && !hasDeps) {
      return reply.badRequest('no updatable fields provided');
    }

    // Validate file paths if provided
    if (hasFiles) {
      const err = validateFilePaths(body.files!);
      if (err) return reply.badRequest(err);
    }

    const row = await tasksCore.getById(db, id);
    if (!row) {
      return reply.notFound('task not found');
    }
    if (row.status !== 'pending') {
      return reply.conflict('task can only be edited when pending');
    }

    // Mixed-protocol check: evaluate resulting state (existing row + patch)
    const resultSourcePath = 'sourcePath' in body ? body.sourcePath : (row as any).sourcePath ?? (row as any).source_path;
    const resultDesc = 'description' in body ? body.description : row.description;
    const resultAC = 'acceptanceCriteria' in body ? body.acceptanceCriteria : (row as any).acceptanceCriteria ?? (row as any).acceptance_criteria;
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
        const dep = await tasksCore.getById(db, depId);
        if (!dep) {
          return reply.badRequest(`Dependency task ${depId} does not exist`);
        }
        // Only direct mutual cycles (A<->B) are detected
        const existingDepsOfDep = await depsForTask(depId);
        if (existingDepsOfDep.includes(id)) {
          return reply.badRequest(`Cycle detected: task ${id} and task ${depId} depend on each other`);
        }
      }
    }

    if ('sourcePath' in body && typeof body.sourcePath === 'string') {
      let patchProject;
      try {
        const patchProjectId = row.projectId ?? (row as any).project_id;
        const dbRow = await projectsQ.getById(db, patchProjectId);
        patchProject = getProject(config, patchProjectId, dbRow ?? undefined);
      } catch {
        return reply.badRequest(`Unknown project: "${row.projectId ?? (row as any).project_id}"`);
      }
      const bareRepo = patchProject.bareRepoPath;
      if (bareRepo) {
        const seedBranch = seedBranchFor(row.projectId ?? (row as any).project_id, patchProject);
        if (!existsInBareRepo(bareRepo, seedBranch, body.sourcePath)) {
          return reply.unprocessableEntity(
            `sourcePath '${body.sourcePath}' not found on branch '${seedBranch}' in bare repo`
          );
        }
      } else {
        const worktree = patchProject.path;
        if (!isCommittedInRepo(worktree, body.sourcePath)) {
          return reply.unprocessableEntity(
            `sourcePath '${body.sourcePath}' is not committed in the staging worktree (${worktree}). ` +
            `Commit it first: git add ${body.sourcePath} && git commit`
          );
        }
      }
    }

    if (hasScalarFields) {
      const updated = await tasksCore.patch(db, id, patchFields);
      if (!updated) {
        return reply.conflict('task is no longer pending');
      }
    }
    if (hasFiles) {
      await taskFilesQ.deleteFilesForTask(db, id);
      await linkFilesToTask(id, body.files!, row.projectId ?? (row as any).project_id);
    }
    if (hasDeps) {
      await taskDepsQ.deleteDepsForTask(db, id);
      await linkDepsToTask(id, body.dependsOn!);
    }

    return { ok: true };
  });

  // DELETE /tasks/:id — delete a single task
  fastify.delete<{
    Params: { id: string };
  }>('/tasks/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const db = getDb();
    const task = await tasksCore.getById(db, id);
    if (!task) {
      return reply.notFound('task not found');
    }
    if (task.status === 'claimed' || task.status === 'in_progress') {
      return reply.conflict('cannot delete a task that is claimed or in progress — release it first');
    }
    await tasksCore.deleteById(db, id);
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
    const db = getDb();
    const deleted = await tasksCore.deleteByStatus(db, status);
    return { ok: true, deleted };
  });
};

export default tasksPlugin;
