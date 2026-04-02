import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import * as ubtQ from './ubt.js';
import * as agentQ from './agents.js';

describe('ubt queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;
  });

  after(async () => {
    await tdb.close();
  });

  it('should return null when no lock exists', async () => {
    const lock = await ubtQ.getLock(db);
    assert.equal(lock, null);
  });

  it('should acquire a lock', async () => {
    await ubtQ.acquireLock(db, 'agent-1', 5);
    const lock = await ubtQ.getLock(db);
    assert.ok(lock);
    assert.equal(lock.holder, 'agent-1');
    assert.equal(lock.priority, 5);
  });

  it('should upsert lock on re-acquire', async () => {
    await ubtQ.acquireLock(db, 'agent-2', 10);
    const lock = await ubtQ.getLock(db);
    assert.ok(lock);
    assert.equal(lock.holder, 'agent-2');
    assert.equal(lock.priority, 10);
  });

  it('should release lock', async () => {
    await ubtQ.releaseLock(db);
    const lock = await ubtQ.getLock(db);
    assert.equal(lock, null);
  });

  it('should enqueue and return id', async () => {
    const id = await ubtQ.enqueue(db, 'agent-a', 3);
    assert.equal(typeof id, 'number');
    assert.ok(id > 0);
  });

  it('should get queue ordered by priority DESC, id ASC', async () => {
    await ubtQ.enqueue(db, 'agent-b', 5);
    await ubtQ.enqueue(db, 'agent-c', 1);

    const queue = await ubtQ.getQueue(db);
    assert.ok(queue.length >= 3);
    // First entry should be highest priority
    assert.equal(queue[0].agent, 'agent-b');
    // Last should be lowest priority
    assert.equal(queue[queue.length - 1].agent, 'agent-c');
  });

  it('should dequeue highest priority entry', async () => {
    const entry = await ubtQ.dequeue(db);
    assert.ok(entry);
    assert.equal(entry.agent, 'agent-b');

    // Should be removed from queue
    const queue = await ubtQ.getQueue(db);
    assert.ok(!queue.some((e) => e.agent === 'agent-b'));
  });

  it('should find agent in queue', async () => {
    const found = await ubtQ.findInQueue(db, 'agent-a');
    assert.ok(found);
    assert.equal(typeof found.id, 'number');
    assert.equal(found.priority, 3);
  });

  it('should return null for agent not in queue', async () => {
    const found = await ubtQ.findInQueue(db, 'no-such');
    assert.equal(found, null);
  });

  it('should get queue position', async () => {
    const found = await ubtQ.findInQueue(db, 'agent-c');
    assert.ok(found);
    const pos = await ubtQ.getQueuePosition(db, found.id, found.priority!);
    assert.equal(typeof pos, 'number');
    assert.ok(pos >= 1);
  });

  it('should dequeue returning null when empty', async () => {
    // Drain the queue
    let entry = await ubtQ.dequeue(db);
    while (entry) {
      entry = await ubtQ.dequeue(db);
    }
    const result = await ubtQ.dequeue(db);
    assert.equal(result, null);
  });

  it('should check isAgentRegistered', async () => {
    // No agents registered yet
    const notReg = await ubtQ.isAgentRegistered(db, 'agent-1');
    assert.equal(notReg, false);

    // Register one
    await agentQ.register(db, { name: 'agent-1', worktree: 'w1' });
    const reg = await ubtQ.isAgentRegistered(db, 'agent-1');
    assert.equal(reg, true);

    // Set to stopping
    await agentQ.softDelete(db, 'agent-1');
    const stopped = await ubtQ.isAgentRegistered(db, 'agent-1');
    assert.equal(stopped, false);

    // Cleanup
    await agentQ.hardDelete(db, 'agent-1');
  });
});
