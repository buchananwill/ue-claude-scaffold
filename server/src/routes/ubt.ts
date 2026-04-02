import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as ubtQ from '../queries/ubt.js';
import * as buildsQ from '../queries/builds.js';
import type { ScaffoldConfig } from '../config.js';

interface UbtOpts {
  config: ScaffoldConfig;
}

let _timeoutMs = 600000;

export function isStale(acquiredAt: string | Date | null): boolean {
  if (!acquiredAt) return true;
  const ts = typeof acquiredAt === 'string'
    ? new Date(acquiredAt.endsWith('Z') ? acquiredAt : acquiredAt + 'Z').getTime()
    : acquiredAt.getTime();
  const elapsed = Date.now() - ts;
  return elapsed > _timeoutMs;
}

export async function recordBuildStart(agent: string, type: 'build' | 'test', projectId: string = 'default'): Promise<number> {
  const db = getDb();
  return buildsQ.insertHistory(db, { agent, type, projectId });
}

export async function recordBuildEnd(id: number, durationMs: number, success: boolean, output: string, stderr: string): Promise<void> {
  const db = getDb();
  await buildsQ.updateHistory(db, id, { durationMs, success, output, stderr });
}

export interface LastBuildResult {
  success: boolean;
  output: string;
  stderr: string;
}

/** Return the most recent completed build/test result for an agent, or null if none. */
export async function getLastBuildResult(agent: string, type: 'build' | 'test'): Promise<LastBuildResult | null> {
  const db = getDb();
  const row = await buildsQ.lastCompleted(db, agent, type);
  if (!row) return null;
  return {
    success: row.success === 1,
    output: (row.output as string) ?? '',
    stderr: (row.stderr as string) ?? '',
  };
}

export async function getEstimatedBuildMs(type?: string): Promise<number> {
  const db = getDb();
  const avg = await buildsQ.avgDuration(db, type ?? 'build');
  return avg ?? 300_000;
}

export async function clearLockAndPromote(projectId: string = 'default'): Promise<{ promoted?: string }> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await ubtQ.releaseLock(tx as any, projectId);
    const next = await ubtQ.dequeue(tx as any, projectId);
    if (next) {
      await ubtQ.acquireLock(tx as any, next.agent, next.priority, projectId);
      return { promoted: next.agent };
    }
    return {};
  });
}

export async function sweepStaleLock(): Promise<void> {
  const db = getDb();
  const lock = await ubtQ.getLock(db);
  if (!lock) return;

  if (isStale(lock.acquiredAt)) {
    await clearLockAndPromote();
  } else if (lock.holder != null) {
    const registered = await ubtQ.isAgentRegistered(db, lock.holder);
    if (!registered) {
      await clearLockAndPromote();
    }
  }
}

const ubtPlugin: FastifyPluginAsync<UbtOpts> = async (fastify, opts) => {
  _timeoutMs = opts.config.server.ubtLockTimeoutMs;

  fastify.get('/ubt/status', async (request) => {
    const projectId = request.projectId;
    const db = getDb();
    const lock = await ubtQ.getLock(db, projectId);
    const queue = await ubtQ.getQueue(db, projectId);

    if (lock && isStale(lock.acquiredAt)) {
      return { holder: null, acquiredAt: null, stale: true, queue, estimatedWaitMs: 0 };
    }

    if (!lock?.holder) {
      return {
        holder: null,
        acquiredAt: null,
        queue,
        estimatedWaitMs: 0,
      };
    }

    const estimatedMs = await getEstimatedBuildMs();
    return {
      holder: lock.holder,
      acquiredAt: lock.acquiredAt ?? null,
      queue,
      estimatedWaitMs: estimatedMs * (queue.length + 1),
    };
  });

  fastify.post<{
    Body: { agent: string; priority?: number };
  }>('/ubt/acquire', async (request) => {
    const { agent, priority = 0 } = request.body;
    const projectId = request.projectId;
    const db = getDb();

    // Pre-compute estimated build time outside the transaction to avoid
    // deadlock on single-connection backends (PGlite).
    const estimatedMs = await getEstimatedBuildMs();

    return db.transaction(async (tx) => {
      const lock = await ubtQ.getLock(tx as any, projectId);

      if (!lock || isStale(lock.acquiredAt)) {
        await ubtQ.acquireLock(tx as any, agent, priority, projectId);
        return { granted: true };
      }

      if (lock.holder === agent) {
        return { granted: true };
      }

      const existing = await ubtQ.findInQueue(tx as any, agent, projectId);
      if (existing) {
        const pos = await ubtQ.getQueuePosition(tx as any, existing.id, existing.priority ?? 0);
        return {
          granted: false,
          position: pos,
          backoffMs: pos * 5000,
          holder: lock.holder,
          holderSince: lock.acquiredAt,
          estimatedWaitMs: estimatedMs * pos,
        };
      }

      const queueId = await ubtQ.enqueue(tx as any, agent, priority, projectId);
      const pos = await ubtQ.getQueuePosition(tx as any, queueId, priority);

      return {
        granted: false,
        position: pos,
        backoffMs: pos * 5000,
        holder: lock.holder,
        holderSince: lock.acquiredAt,
        estimatedWaitMs: estimatedMs * pos,
      };
    });
  });

  fastify.post<{
    Body: { agent: string };
  }>('/ubt/release', async (request) => {
    const { agent } = request.body;
    const projectId = request.projectId;
    const db = getDb();

    const lock = await ubtQ.getLock(db, projectId);

    if (!lock) {
      return { ok: false, reason: 'not_held' };
    }

    if (lock.holder !== agent) {
      return { ok: false, reason: 'not_holder' };
    }

    const result = await clearLockAndPromote(projectId);
    return { ok: true, ...result };
  });
};

export default ubtPlugin;
