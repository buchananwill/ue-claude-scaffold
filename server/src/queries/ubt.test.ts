import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import * as ubtQ from './ubt.js';
import * as agentQ from './agents.js';

describe('ubt queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;

  // Pre-registered agent UUIDs for use in lock/queue operations
  let agent1Id: string;
  let agent2Id: string;
  let agentAId: string;
  let agentBId: string;
  let agentCId: string;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;

    // Register agents to get UUIDs (UBT uses agent UUIDs, not names)
    agent1Id = (await agentQ.register(db, { name: 'agent-1', worktree: 'w1', projectId: 'default', sessionToken: 'ubt-tok-1' })).id;
    agent2Id = (await agentQ.register(db, { name: 'agent-2', worktree: 'w2', projectId: 'default', sessionToken: 'ubt-tok-2' })).id;
    agentAId = (await agentQ.register(db, { name: 'agent-a', worktree: 'wa', projectId: 'default', sessionToken: 'ubt-tok-a' })).id;
    agentBId = (await agentQ.register(db, { name: 'agent-b', worktree: 'wb', projectId: 'default', sessionToken: 'ubt-tok-b' })).id;
    agentCId = (await agentQ.register(db, { name: 'agent-c', worktree: 'wc', projectId: 'default', sessionToken: 'ubt-tok-c' })).id;
  });

  after(async () => {
    await tdb.close();
  });

  it('should return null when no lock exists', async () => {
    const lock = await ubtQ.getLock(db);
    assert.equal(lock, null);
  });

  it('should acquire a lock', async () => {
    await ubtQ.acquireLock(db, agent1Id, 5);
    const lock = await ubtQ.getLock(db);
    assert.ok(lock);
    assert.equal(lock.holderAgentId, agent1Id);
    assert.equal(lock.priority, 5);
  });

  it('should upsert lock on re-acquire', async () => {
    await ubtQ.acquireLock(db, agent2Id, 10);
    const lock = await ubtQ.getLock(db);
    assert.ok(lock);
    assert.equal(lock.holderAgentId, agent2Id);
    assert.equal(lock.priority, 10);
  });

  it('should release lock', async () => {
    await ubtQ.releaseLock(db);
    const lock = await ubtQ.getLock(db);
    assert.equal(lock, null);
  });

  it('should enqueue and return id', async () => {
    const id = await ubtQ.enqueue(db, agentAId, 3);
    assert.equal(typeof id, 'number');
    assert.ok(id > 0);
  });

  it('should get queue ordered by priority DESC, id ASC', async () => {
    await ubtQ.enqueue(db, agentBId, 5);
    await ubtQ.enqueue(db, agentCId, 1);

    const queue = await ubtQ.getQueue(db);
    assert.ok(queue.length >= 3);
    // First entry should be highest priority
    assert.equal(queue[0].agentId, agentBId);
    // Last should be lowest priority
    assert.equal(queue[queue.length - 1].agentId, agentCId);
  });

  it('should dequeue highest priority entry', async () => {
    const entry = await ubtQ.dequeue(db);
    assert.ok(entry);
    assert.equal(entry.agentId, agentBId);

    // Should be removed from queue
    const queue = await ubtQ.getQueue(db);
    assert.ok(!queue.some((e) => e.agentId === agentBId));
  });

  it('should find agent in queue', async () => {
    const found = await ubtQ.findInQueue(db, agentAId);
    assert.ok(found);
    assert.equal(typeof found.id, 'number');
    assert.equal(found.priority, 3);
  });

  it('should return null for agent not in queue', async () => {
    const found = await ubtQ.findInQueue(db, agent1Id);
    assert.equal(found, null);
  });

  it('should get queue position', async () => {
    const found = await ubtQ.findInQueue(db, agentCId);
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
    // agent-1 was registered in before()
    const reg = await ubtQ.isAgentRegistered(db, agent1Id);
    assert.equal(reg, true);

    // Set to stopping (softDelete sets to 'deleted', use stopAgent for 'stopping')
    await agentQ.updateStatus(db, 'default', 'agent-1', 'stopping');
    const stopped = await ubtQ.isAgentRegistered(db, agent1Id);
    assert.equal(stopped, false);

    // Restore to idle for other tests
    await agentQ.updateStatus(db, 'default', 'agent-1', 'idle');
  });
});
