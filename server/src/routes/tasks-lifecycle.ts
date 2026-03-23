import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db.js';
import { existsInBareRepo, isCommittedInRepo } from '../git-utils.js';
import type { TaskRow } from './tasks-types.js';
import type { TasksOpts, TasksSharedStatements } from './tasks-files.js';

interface TasksLifecycleOpts extends TasksOpts {
  shared: TasksSharedStatements;
}

const tasksLifecyclePlugin: FastifyPluginAsync<TasksLifecycleOpts> = async (fastify, opts) => {
  const config = opts.config;
  const shared = opts.shared;

  // POST /tasks/:id/complete
  fastify.post<{
    Params: { id: string };
    Body: { result: unknown };
  }>('/tasks/:id/complete', async (request, reply) => {
    const id = Number(request.params.id);
    const { result } = request.body;

    const info = shared.completeTask.run({ id, result: JSON.stringify(result) });
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

    const info = shared.failTask.run({ id, result: JSON.stringify({ error }) });
    if (info.changes === 0) {
      return reply.conflict('task not in claimed or in_progress state');
    }
    return { ok: true };
  });

  // POST /tasks/:id/reset — reset a completed/failed task back to pending
  fastify.post<{
    Params: { id: string };
  }>('/tasks/:id/reset', async (request, reply) => {
    const id = Number(request.params.id);

    const row = shared.getTaskById.get({ id }) as TaskRow | undefined;
    if (!row) {
      return reply.notFound('task not found');
    }
    if (row.status !== 'completed' && row.status !== 'failed' && row.status !== 'cycle') {
      return reply.conflict('task can only be reset when completed, failed, or cycle');
    }

    if (row.source_path && row.status !== 'cycle') {
      const bareRepo = shared.getBareRepoPath();
      if (bareRepo) {
        const planBranch = config.tasks?.planBranch ?? 'docker/current-root';
        if (!existsInBareRepo(bareRepo, planBranch, row.source_path)) {
          return reply.unprocessableEntity(
            `sourcePath '${row.source_path}' not found on branch '${planBranch}' in bare repo`
          );
        }
      } else {
        const worktree = shared.getValidationWorktree();
        if (!isCommittedInRepo(worktree, row.source_path)) {
          return reply.unprocessableEntity(
            `sourcePath '${row.source_path}' is no longer committed in the staging worktree`
          );
        }
      }
    }

    const info = shared.resetTask.run({ id });
    if (info.changes === 0) {
      return reply.conflict('task is no longer in a resettable state');
    }
    return { ok: true };
  });

  // POST /tasks/:id/integrate — mark a single completed task as integrated
  fastify.post<{
    Params: { id: string };
  }>('/tasks/:id/integrate', async (request, reply) => {
    const id = Number(request.params.id);

    const row = shared.getTaskById.get({ id }) as TaskRow | undefined;
    if (!row) {
      return reply.notFound('task not found');
    }
    if (row.status !== 'completed') {
      return reply.badRequest('task must be in completed status to integrate');
    }

    const info = shared.integrateTask.run({ id });
    if (info.changes === 0) {
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

    const result = db.transaction(() => {
      const rows = shared.selectCompletedByAgent.all(agent) as { id: number }[];
      const ids = rows.map(r => r.id);
      shared.integrateBatch.run(agent);
      return { ok: true, count: ids.length, ids };
    })();

    return result;
  });

  // POST /tasks/integrate-all — mark all completed tasks as integrated
  fastify.post('/tasks/integrate-all', async () => {
    const result = db.transaction(() => {
      const rows = shared.selectAllCompleted.all() as { id: number }[];
      const ids = rows.map(r => r.id);
      shared.integrateAll.run();
      return { ok: true, count: ids.length, ids };
    })();

    return result;
  });
};

export default tasksLifecyclePlugin;
