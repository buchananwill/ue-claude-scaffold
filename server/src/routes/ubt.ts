import type { FastifyPluginAsync } from 'fastify';
import type Database from 'better-sqlite3';
import { db } from '../db.js';
import type { ScaffoldConfig } from '../config.js';

interface UbtOpts {
  config: ScaffoldConfig;
}

let getLock: Database.Statement;
let insertLock: Database.Statement;
let clearLock: Database.Statement;
let popNext: Database.Statement;

let isAgentRegistered: Database.Statement;

let insertBuildHistory: Database.Statement;
let updateBuildHistory: Database.Statement;
let avgBuildDuration: Database.Statement;

function initBuildHistoryStatements(): void {
  insertBuildHistory = db.prepare(
    'INSERT INTO build_history (agent, type) VALUES (@agent, @type)'
  );
  updateBuildHistory = db.prepare(
    'UPDATE build_history SET duration_ms = @durationMs, success = @success, output = @output, stderr = @stderr WHERE id = @id'
  );
  avgBuildDuration = db.prepare(
    `SELECT AVG(duration_ms) as avg_ms FROM (
      SELECT duration_ms FROM build_history
      WHERE type = @type AND success = 1 AND duration_ms IS NOT NULL
      ORDER BY id DESC LIMIT 5
    )`
  );
}

export function initUbtStatements(): void {
  getLock = db.prepare('SELECT * FROM ubt_lock WHERE id = 1');
  insertLock = db.prepare(
    `INSERT OR REPLACE INTO ubt_lock (id, holder, acquired_at, priority)
     VALUES (1, @holder, CURRENT_TIMESTAMP, @priority)`
  );
  clearLock = db.prepare('DELETE FROM ubt_lock WHERE id = 1');
  popNext = db.prepare(
    `DELETE FROM ubt_queue WHERE id = (
       SELECT id FROM ubt_queue ORDER BY priority DESC, id ASC LIMIT 1
     ) RETURNING *`
  );
  isAgentRegistered = db.prepare('SELECT 1 FROM agents WHERE name = @holder');
  initBuildHistoryStatements();
}

export function recordBuildStart(agent: string, type: 'build' | 'test'): number {
  return Number(insertBuildHistory.run({ agent, type }).lastInsertRowid);
}

export function recordBuildEnd(id: number, durationMs: number, success: boolean, output: string, stderr: string): void {
  updateBuildHistory.run({ id, durationMs, success: success ? 1 : 0, output, stderr });
}

export function getEstimatedBuildMs(type?: string): number {
  const row = avgBuildDuration.get({ type: type ?? 'build' }) as { avg_ms: number | null } | undefined;
  return row?.avg_ms ? Math.round(row.avg_ms) : 300_000;
}

let _timeoutMs = 600000;

export function isStale(acquiredAt: string | null): boolean {
  if (!acquiredAt) return true;
  const elapsed = Date.now() - new Date(acquiredAt + 'Z').getTime();
  return elapsed > _timeoutMs;
}

export function clearLockAndPromote(): { promoted?: string } {
  return db.transaction(() => {
    clearLock.run();

    const next = popNext.get() as {
      agent: string;
      priority: number;
    } | undefined;

    if (next) {
      insertLock.run({ holder: next.agent, priority: next.priority });
      return { promoted: next.agent };
    }

    return {};
  })();
}

export function sweepStaleLock(): void {
  const lock = getLock.get() as {
    holder: string | null;
    acquired_at: string | null;
  } | undefined;

  if (lock && isStale(lock.acquired_at)) {
    clearLockAndPromote();
  } else if (lock && lock.holder != null && !isAgentRegistered.get({ holder: lock.holder })) {
    clearLockAndPromote();
  }
}

const ubtPlugin: FastifyPluginAsync<UbtOpts> = async (fastify, opts) => {
  initUbtStatements();
  _timeoutMs = opts.config.server.ubtLockTimeoutMs;

  const enqueue = db.prepare(
    `INSERT INTO ubt_queue (agent, priority) VALUES (@agent, @priority)`
  );
  const getQueue = db.prepare(
    'SELECT * FROM ubt_queue ORDER BY priority DESC, id ASC'
  );
  const queuePosition = db.prepare(
    `SELECT COUNT(*) as pos FROM ubt_queue WHERE
       priority > @priority OR (priority = @priority AND id <= @id)`
  );
  const findInQueue = db.prepare(
    'SELECT id, priority FROM ubt_queue WHERE agent = @agent'
  );

  fastify.get('/ubt/status', async () => {
    const lock = getLock.get() as {
      holder: string | null;
      acquired_at: string | null;
      priority: number;
    } | undefined;
    const queue = getQueue.all();

    if (lock && isStale(lock.acquired_at)) {
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

    return {
      holder: lock.holder,
      acquiredAt: lock.acquired_at ?? null,
      queue,
      estimatedWaitMs: getEstimatedBuildMs() * (queue.length + 1),
    };
  });

  fastify.post<{
    Body: { agent: string; priority?: number };
  }>('/ubt/acquire', async (request) => {
    const { agent, priority = 0 } = request.body;

    return db.transaction(() => {
      const lock = getLock.get() as {
        holder: string | null;
        acquired_at: string | null;
      } | undefined;

      if (!lock || isStale(lock.acquired_at)) {
        insertLock.run({ holder: agent, priority });
        return { granted: true };
      }

      if (lock.holder === agent) {
        return { granted: true };
      }

      const existing = findInQueue.get({ agent }) as { id: number; priority: number } | undefined;
      if (existing) {
        const pos = (queuePosition.get({
          priority: existing.priority,
          id: existing.id,
        }) as { pos: number }).pos;
        return {
          granted: false,
          position: pos,
          backoffMs: pos * 5000,
          holder: lock.holder,
          holderSince: lock.acquired_at,
          estimatedWaitMs: getEstimatedBuildMs() * pos,
        };
      }

      const entry = enqueue.run({ agent, priority });
      const pos = (queuePosition.get({
        priority,
        id: Number(entry.lastInsertRowid),
      }) as { pos: number }).pos;

      return {
        granted: false,
        position: pos,
        backoffMs: pos * 5000,
        holder: lock.holder,
        holderSince: lock.acquired_at,
        estimatedWaitMs: getEstimatedBuildMs() * pos,
      };
    })();
  });

  fastify.post<{
    Body: { agent: string };
  }>('/ubt/release', async (request) => {
    const { agent } = request.body;

    const lock = getLock.get() as {
      holder: string | null;
    } | undefined;

    if (!lock) {
      return { ok: false, reason: 'not_held' };
    }

    if (lock.holder !== agent) {
      return { ok: false, reason: 'not_holder' };
    }

    const result = clearLockAndPromote();
    return { ok: true, ...result };
  });
};

export default ubtPlugin;
