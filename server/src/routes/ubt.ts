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
      return { holder: null, acquiredAt: null, stale: true, queue };
    }

    return {
      holder: lock?.holder ?? null,
      acquiredAt: lock?.acquired_at ?? null,
      queue,
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
