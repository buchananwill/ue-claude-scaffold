import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as tasksCore from '../queries/tasks-core.js';
import * as taskFilesQ from '../queries/task-files.js';
import * as taskDepsQ from '../queries/task-deps.js';
import type { ScaffoldConfig } from '../config.js';
import { mergeIntoAgentBranches } from '../git-utils.js';
import { AGENT_NAME_RE } from '../branch-naming.js';
import { resolveProject } from '../resolve-project.js';
import { validateSourcePath } from '../tasks-validation.js';
import { formatTask, toTaskRow, type TaskRow } from './tasks-types.js';
import {
  type TasksOpts, type TaskBody, type PatchBody,
  taskBodyKeys, patchBodyKeys,
  hasValue, validateFilePaths, unknownFields,
  linkFilesToTask, linkDepsToTask, depsForTask,
  formatTaskWithFiles,
} from './tasks-files.js';
import tasksReplanPlugin, { runReplan } from './tasks-replan.js';
import tasksClaimPlugin from './tasks-claim.js';
import tasksLifecyclePlugin from './tasks-lifecycle.js';
export { formatTask, toTaskRow, type TaskRow } from './tasks-types.js';

/**
 * Parse a comma-separated query string into an array of non-empty strings.
 * Returns `undefined` if the input is falsy. Returns an error string if
 * empty segments are found (leading/trailing/doubled commas) or if the
 * array exceeds `maxValues` elements.
 */
export function parseCommaFilter(
  raw: string | undefined,
  label: string,
  maxValues = 50,
): { values: string[] | undefined; error?: string } {
  if (!raw) return { values: undefined };
  const parts = raw.split(',');
  const filtered = parts.filter(Boolean);
  if (parts.length !== filtered.length) {
    return {
      values: undefined,
      error: `Invalid ${label} filter: contains empty segments (leading, trailing, or doubled commas).`,
    };
  }
  if (filtered.length > maxValues) {
    return {
      values: undefined,
      error: `Too many ${label} values (max ${maxValues}).`,
    };
  }
  return { values: filtered };
}

interface TaskListQueryInput {
  status?: string;
  agent?: string;
  priority?: string;
  sort?: string;
  dir?: string;
  limit?: string;
  offset?: string;
}

interface ParsedTaskListQuery {
  statusArr: string[] | undefined;
  agentArr: string[] | undefined;
  priorityArr: number[] | undefined;
  sortCol: tasksCore.SortColumn | undefined;
  dirVal: 'asc' | 'desc' | undefined;
  limitNum: number;
  offsetNum: number;
}

type ParseResult =
  | { ok: true; data: ParsedTaskListQuery }
  | { ok: false; error: string };

/**
 * Parse and validate all query parameters for `GET /tasks`. Returns a
 * discriminated union: `{ ok: true, data }` on success, `{ ok: false, error }`
 * on validation failure. The caller is responsible for sending the 400 reply.
 */
export function parseTaskListQuery(
  query: TaskListQueryInput,
): ParseResult {
  const { status, agent: agentFilter, priority: priorityFilter, sort, dir, limit, offset } = query;
  const limitNum = Math.min(Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : tasksCore.DEFAULT_LIST_LIMIT), 500);
  const offsetNum = Math.max(0, Number.isFinite(Number(offset)) ? Number(offset) : 0);

  // --- comma-separated filters ---
  const statusResult = parseCommaFilter(status, 'status');
  if (statusResult.error) return { ok: false, error: statusResult.error };
  const statusArr = statusResult.values;

  const agentResult = parseCommaFilter(agentFilter, 'agent');
  if (agentResult.error) return { ok: false, error: agentResult.error };
  const agentArr = agentResult.values;

  const priorityResult = parseCommaFilter(priorityFilter, 'priority');
  if (priorityResult.error) return { ok: false, error: priorityResult.error };

  // Additional numeric validation for priority
  let priorityArr: number[] | undefined;
  if (priorityResult.values) {
    const parsed = priorityResult.values.map(Number).filter(v => Number.isFinite(v) && Number.isInteger(v));
    if (parsed.length < priorityResult.values.length) {
      const invalid = priorityResult.values.filter(s => { const n = Number(s); return !Number.isFinite(n) || !Number.isInteger(n); });
      return { ok: false, error: `Invalid priority values: ${invalid.map(v => v.slice(0, 32)).join(', ')}. Priority must be integers.` };
    }
    priorityArr = parsed;
  }

  // Validate status values against known statuses
  if (statusArr) {
    for (const s of statusArr) {
      if (!(tasksCore.VALID_TASK_STATUSES as readonly string[]).includes(s)) {
        return { ok: false, error: `Invalid status value: "${s.slice(0, 32)}". Valid statuses: ${tasksCore.VALID_TASK_STATUSES.join(', ')}` };
      }
    }
  }

  // Validate agent names
  if (agentArr) {
    for (const a of agentArr) {
      if (a === '__unassigned__') continue;
      if (!AGENT_NAME_RE.test(a)) {
        return { ok: false, error: `Invalid agent name: "${a.slice(0, 64)}".` };
      }
    }
  }

  // Validate sort column
  let sortCol: tasksCore.SortColumn | undefined;
  if (sort) {
    if (!tasksCore.VALID_SORT_COLUMNS.includes(sort)) {
      return { ok: false, error: `Invalid sort column: "${sort.slice(0, 32)}". Valid columns: ${tasksCore.VALID_SORT_COLUMNS.join(', ')}` };
    }
    sortCol = sort as tasksCore.SortColumn;
  }

  // Validate dir
  let dirVal: 'asc' | 'desc' | undefined;
  if (dir) {
    if (dir !== 'asc' && dir !== 'desc') {
      return { ok: false, error: 'Invalid dir: must be "asc" or "desc"' };
    }
    if (!sort) {
      return { ok: false, error: 'dir requires sort to be specified' };
    }
    dirVal = dir;
  }

  return { ok: true, data: { statusArr, agentArr, priorityArr, sortCol, dirVal, limitNum, offsetNum } };
}

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
      const spCheck = await validateSourcePath({
        sourcePath, projectId, config, db: getDb(), log: fastify.log, autoSync: true,
      });
      if (!spCheck.valid) {
        return spCheck.code === 400
          ? reply.badRequest(spCheck.message)
          : reply.unprocessableEntity(spCheck.message);
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
    let mergedAgents: string[] = [];
    let failedMerges: Array<{ agent: string; reason: string }> = [];

    if (targetAgents) {
      // Validate agent names before resolving
      const agentList = targetAgents === '*' ? targetAgents : targetAgents as string[];
      if (Array.isArray(agentList)) {
        for (const agentName of agentList) {
          if (typeof agentName !== 'string' || !AGENT_NAME_RE.test(agentName)) {
            return reply.badRequest(`Invalid agent name in targetAgents: "${String(agentName).slice(0, 64)}"`);
          }
        }
      }

      let mergeProject;
      try {
        mergeProject = await resolveProject(config, db, projectId);
      } catch {
        return reply.badRequest(`Unknown project: "${projectId}"`);
      }
      const bareRepo = mergeProject.bareRepoPath;
      if (!bareRepo) {
        fastify.log.warn('targetAgents requested but bareRepoPath is not configured');
      } else {
        const mergeResult = await mergeIntoAgentBranches({
          bareRepo, projectId, project: mergeProject,
          targetAgents: agentList, db, log: fastify.log,
        });
        mergedAgents = mergeResult.mergedAgents;
        failedMerges = mergeResult.failedMerges;
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
        // Auto-sync on first miss in the batch (once per batch)
        const spCheck = await validateSourcePath({
          sourcePath: t.sourcePath, projectId, config, db, log: fastify.log,
          autoSync: !batchSynced, label: `Task ${i}`,
        });
        if (spCheck.synced) batchSynced = true;
        if (!spCheck.valid) {
          return spCheck.code === 400
            ? reply.badRequest(spCheck.message)
            : reply.unprocessableEntity(spCheck.message);
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
    Querystring: {
      status?: string;
      agent?: string;
      priority?: string;
      sort?: string;
      dir?: string;
      limit?: string;
      offset?: string;
    };
  }>('/tasks', async (request, reply) => {
    const projectId = request.projectId;

    const parsed = parseTaskListQuery(request.query);
    if (!parsed.ok) return reply.badRequest(parsed.error);
    const { statusArr, agentArr, priorityArr, sortCol, dirVal, limitNum, offsetNum } = parsed.data;

    const db = getDb();
    const filterOpts = {
      status: statusArr,
      agent: agentArr,
      priority: priorityArr,
      projectId,
    };
    const rows = await tasksCore.list(db, { ...filterOpts, limit: limitNum, offset: offsetNum, sort: sortCol, dir: dirVal });
    const total = await tasksCore.count(db, filterOpts);
    const agent = (request.headers['x-agent-name'] as string) ?? 'unknown';

    const formattedTasks = await Promise.all(
      rows.map(r => formatTaskWithFiles(toTaskRow(r), agent, config))
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
    return formatTaskWithFiles(toTaskRow(row), agent, config);
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
    const resultSourcePath = 'sourcePath' in body ? body.sourcePath : row.sourcePath;
    const resultDesc = 'description' in body ? body.description : row.description;
    const resultAC = 'acceptanceCriteria' in body ? body.acceptanceCriteria : row.acceptanceCriteria;
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
      const patchProjectId = row.projectId;
      const spCheck = await validateSourcePath({
        sourcePath: body.sourcePath, projectId: patchProjectId, config, db,
      });
      if (!spCheck.valid) {
        return spCheck.code === 400
          ? reply.badRequest(spCheck.message)
          : reply.unprocessableEntity(spCheck.message);
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
      await linkFilesToTask(id, body.files!, row.projectId);
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
    if (!(tasksCore.VALID_TASK_STATUSES as readonly string[]).includes(status)) {
      return reply.badRequest(`Invalid status value: "${status.slice(0, 32)}". Valid statuses: ${tasksCore.VALID_TASK_STATUSES.join(', ')}`);
    }
    if (status === 'claimed' || status === 'in_progress') {
      return reply.conflict('cannot bulk-delete tasks that are claimed or in progress');
    }
    const db = getDb();
    const deleted = await tasksCore.deleteByStatus(db, status, request.projectId);
    return { ok: true, deleted };
  });
};

export default tasksPlugin;
