import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as tasksCore from '../queries/tasks-core.js';
import * as tasksLifecycleQ from '../queries/tasks-lifecycle.js';
import { existsInBareRepo, isCommittedInRepo } from '../git-utils.js';
import type { TaskRow } from './tasks-types.js';
import type { TasksOpts } from './tasks-files.js';

const tasksLifecyclePlugin: FastifyPluginAsync<TasksOpts> = async (fastify, opts) => {
  const config = opts.config;

  // POST /tasks/:id/complete
  fastify.post<{
    Params: { id: string };
    Body: { result: unknown };
  }>('/tasks/:id/complete', async (request, reply) => {
    const id = Number(request.params.id);
    const { result } = request.body;
    const db = getDb();

    const ok = await tasksLifecycleQ.complete(db, id, result);
    if (!ok) {
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
    const db = getDb();

    const ok = await tasksLifecycleQ.fail(db, id, { error });
    if (!ok) {
      return reply.conflict('task not in claimed or in_progress state');
    }
    return { ok: true };
  });

  // POST /tasks/:id/reset — reset a completed/failed task back to pending
  fastify.post<{
    Params: { id: string };
  }>('/tasks/:id/reset', async (request, reply) => {
    const id = Number(request.params.id);
    const db = getDb();

    const row = await tasksCore.getById(db, id);
    if (!row) {
      return reply.notFound('task not found');
    }
    if (row.status !== 'completed' && row.status !== 'failed' && row.status !== 'cycle') {
      return reply.conflict('task can only be reset when completed, failed, or cycle');
    }

    const sp = row.sourcePath ?? (row as any).source_path;
    if (sp && row.status !== 'cycle') {
      const bareRepo = config.server.bareRepoPath;
      if (bareRepo) {
        const planBranch = config.tasks?.planBranch ?? 'docker/current-root';
        if (!existsInBareRepo(bareRepo, planBranch, sp)) {
          return reply.unprocessableEntity(
            `sourcePath '${sp}' not found on branch '${planBranch}' in bare repo`
          );
        }
      } else {
        const worktree = config.project.path;
        if (!isCommittedInRepo(worktree, sp)) {
          return reply.unprocessableEntity(
            `sourcePath '${sp}' is no longer committed in the staging worktree`
          );
        }
      }
    }

    const ok = await tasksLifecycleQ.reset(db, id);
    if (!ok) {
      return reply.conflict('task is no longer in a resettable state');
    }
    return { ok: true };
  });

  // POST /tasks/:id/integrate — mark a single completed task as integrated
  fastify.post<{
    Params: { id: string };
  }>('/tasks/:id/integrate', async (request, reply) => {
    const id = Number(request.params.id);
    const db = getDb();

    const row = await tasksCore.getById(db, id);
    if (!row) {
      return reply.notFound('task not found');
    }
    if (row.status !== 'completed') {
      return reply.badRequest('task must be in completed status to integrate');
    }

    const ok = await tasksLifecycleQ.integrate(db, id);
    if (!ok) {
      return reply.conflict('task status changed concurrently');
    }
    return { ok: true };
  });

  // POST /tasks/integrate-batch — mark all completed tasks by a specific agent as integrated
  fastify.post<{
    Body: { agent: string };
  }>('/tasks/integrate-batch', async (request, reply) => {
    const { agent } = request.body ?? {};
    if (!agent || typeof agent !== 'string') {
      return reply.badRequest('agent must be a string');
    }

    const db = getDb();
    const result = await tasksLifecycleQ.integrateBatch(db, agent);
    return { ok: true, count: result.count, ids: result.ids };
  });

  // POST /tasks/integrate-all — mark all completed tasks as integrated
  fastify.post('/tasks/integrate-all', async () => {
    const db = getDb();
    const result = await tasksLifecycleQ.integrateAll(db);
    return { ok: true, count: result.count, ids: result.ids };
  });
};

export default tasksLifecyclePlugin;
