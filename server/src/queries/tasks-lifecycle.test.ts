import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import * as lifecycle from './tasks-lifecycle.js';
import * as tasksCore from './tasks-core.js';
import * as agentQ from './agents.js';

describe('tasks-lifecycle queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;
  let agent1Id: string;
  let agentBatchId: string;
  let agentQId: string;
  let agentZId: string;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;

    // Register agents to get UUIDs for claim operations
    agent1Id = (await agentQ.register(db, { name: 'agent-1', worktree: 'w1', projectId: 'default', sessionToken: 'lc-tok-1' })).id;
    agentBatchId = (await agentQ.register(db, { name: 'agent-batch', worktree: 'wb', projectId: 'default', sessionToken: 'lc-tok-batch' })).id;
    agentQId = (await agentQ.register(db, { name: 'agent-q', worktree: 'wq', projectId: 'default', sessionToken: 'lc-tok-q' })).id;
    agentZId = (await agentQ.register(db, { name: 'agent-z', worktree: 'wz', projectId: 'default', sessionToken: 'lc-tok-z' })).id;
  });

  after(async () => {
    await tdb.close();
  });

  it('should claim a pending task', async () => {
    const task = await tasksCore.insert(db, { title: 'Claimable', projectId: 'default' });
    const ok = await lifecycle.claim(db, 'default', task.id, agent1Id);
    assert.equal(ok, true);
    const updated = await tasksCore.getById(db, task.id);
    assert.equal(updated?.status, 'claimed');
    assert.equal(updated?.claimedByAgentId, agent1Id);
    assert.ok(updated?.claimedAt);
  });

  it('should not claim a non-pending task', async () => {
    const task = await tasksCore.insert(db, { title: 'Already Claimed', projectId: 'default' });
    await lifecycle.claim(db, 'default', task.id, agent1Id);
    const agent2Id = (await agentQ.register(db, { name: 'agent-2', worktree: 'w2', projectId: 'default', sessionToken: 'lc-tok-2' })).id;
    const ok = await lifecycle.claim(db, 'default', task.id, agent2Id);
    assert.equal(ok, false);
  });

  it('should update progress', async () => {
    const task = await tasksCore.insert(db, { title: 'Progressing', projectId: 'default' });
    await lifecycle.claim(db, 'default', task.id, agent1Id);
    const ok = await lifecycle.updateProgress(db, 'default', task.id, 'Step 1 done');
    assert.equal(ok, true);
    const updated = await tasksCore.getById(db, task.id);
    assert.equal(updated?.status, 'in_progress');
    assert.ok(updated?.progressLog?.includes('Step 1 done'));
  });

  it('should append to progress log', async () => {
    const task = await tasksCore.insert(db, { title: 'Multi Progress', projectId: 'default' });
    await lifecycle.claim(db, 'default', task.id, agent1Id);
    await lifecycle.updateProgress(db, 'default', task.id, 'First');
    await lifecycle.updateProgress(db, 'default', task.id, 'Second');
    const updated = await tasksCore.getById(db, task.id);
    assert.ok(updated?.progressLog?.includes('First'));
    assert.ok(updated?.progressLog?.includes('Second'));
  });

  it('should complete a claimed task', async () => {
    const task = await tasksCore.insert(db, { title: 'Completable', projectId: 'default' });
    await lifecycle.claim(db, 'default', task.id, agent1Id);
    const ok = await lifecycle.complete(db, 'default', task.id, { agent: 'agent-1', summary: 'done' });
    assert.equal(ok, true);
    const updated = await tasksCore.getById(db, task.id);
    assert.equal(updated?.status, 'completed');
    assert.ok(updated?.completedAt);
    assert.deepEqual(updated?.result, { agent: 'agent-1', summary: 'done' });
  });

  it('should not complete a pending task', async () => {
    const task = await tasksCore.insert(db, { title: 'Not Completable', projectId: 'default' });
    const ok = await lifecycle.complete(db, 'default', task.id, {});
    assert.equal(ok, false);
  });

  it('should fail a claimed task', async () => {
    const task = await tasksCore.insert(db, { title: 'Failable', projectId: 'default' });
    await lifecycle.claim(db, 'default', task.id, agent1Id);
    const ok = await lifecycle.fail(db, 'default', task.id, { error: 'oops' });
    assert.equal(ok, true);
    const updated = await tasksCore.getById(db, task.id);
    assert.equal(updated?.status, 'failed');
  });

  it('should release a claimed task', async () => {
    const task = await tasksCore.insert(db, { title: 'Releasable', projectId: 'default' });
    await lifecycle.claim(db, 'default', task.id, agent1Id);
    const ok = await lifecycle.release(db, 'default', task.id);
    assert.equal(ok, true);
    const updated = await tasksCore.getById(db, task.id);
    assert.equal(updated?.status, 'pending');
    assert.equal(updated?.claimedByAgentId, null);
  });

  it('should not release a pending task', async () => {
    const task = await tasksCore.insert(db, { title: 'Not Releasable', projectId: 'default' });
    const ok = await lifecycle.release(db, 'default', task.id);
    assert.equal(ok, false);
  });

  it('should reset a completed task', async () => {
    const task = await tasksCore.insert(db, { title: 'Resettable', projectId: 'default' });
    await lifecycle.claim(db, 'default', task.id, agent1Id);
    await lifecycle.complete(db, 'default', task.id, { agent: 'agent-1' });
    const ok = await lifecycle.reset(db, 'default', task.id);
    assert.equal(ok, true);
    const updated = await tasksCore.getById(db, task.id);
    assert.equal(updated?.status, 'pending');
    assert.equal(updated?.claimedByAgentId, null);
    assert.equal(updated?.result, null);
    assert.equal(updated?.progressLog, null);
  });

  it('should not reset a pending task', async () => {
    const task = await tasksCore.insert(db, { title: 'Not Resettable', projectId: 'default' });
    const ok = await lifecycle.reset(db, 'default', task.id);
    assert.equal(ok, false);
  });

  it('should integrate a completed task', async () => {
    const task = await tasksCore.insert(db, { title: 'Integratable', projectId: 'default' });
    await lifecycle.claim(db, 'default', task.id, agent1Id);
    await lifecycle.complete(db, 'default', task.id, { agent: 'agent-1' });
    const ok = await lifecycle.integrate(db, 'default', task.id);
    assert.equal(ok, true);
    const updated = await tasksCore.getById(db, task.id);
    assert.equal(updated?.status, 'integrated');
  });

  it('should integrateBatch by agent', async () => {
    const t1 = await tasksCore.insert(db, { title: 'Batch 1', projectId: 'default' });
    const t2 = await tasksCore.insert(db, { title: 'Batch 2', projectId: 'default' });
    await lifecycle.claim(db, 'default', t1.id, agentBatchId);
    await lifecycle.claim(db, 'default', t2.id, agentBatchId);
    await lifecycle.complete(db, 'default', t1.id, { agent: 'agent-batch' });
    await lifecycle.complete(db, 'default', t2.id, { agent: 'agent-batch' });

    const result = await lifecycle.integrateBatch(db, 'default', agentBatchId);
    assert.equal(result.count, 2);
    assert.ok(result.ids.includes(t1.id));
    assert.ok(result.ids.includes(t2.id));
  });

  it('should integrateAll', async () => {
    const t1 = await tasksCore.insert(db, { title: 'IntAll 1', projectId: 'default' });
    const t2 = await tasksCore.insert(db, { title: 'IntAll 2', projectId: 'default' });
    const aId = (await agentQ.register(db, { name: 'int-a', worktree: 'wa', projectId: 'default', sessionToken: 'lc-tok-int-a' })).id;
    const bId = (await agentQ.register(db, { name: 'int-b', worktree: 'wb2', projectId: 'default', sessionToken: 'lc-tok-int-b' })).id;
    await lifecycle.claim(db, 'default', t1.id, aId);
    await lifecycle.claim(db, 'default', t2.id, bId);
    await lifecycle.complete(db, 'default', t1.id, { agent: 'a' });
    await lifecycle.complete(db, 'default', t2.id, { agent: 'b' });

    const result = await lifecycle.integrateAll(db, 'default');
    assert.ok(result.count >= 2);
    assert.ok(result.ids.includes(t1.id));
    assert.ok(result.ids.includes(t2.id));
  });

  it('should getCompletedByAgent', async () => {
    const t = await tasksCore.insert(db, { title: 'CompByAgent', projectId: 'default' });
    await lifecycle.claim(db, 'default', t.id, agentQId);
    await lifecycle.complete(db, 'default', t.id, { agent: 'agent-q' });

    const rows = await lifecycle.getCompletedByAgent(db, 'default', agentQId);
    assert.ok(rows.some((r) => r.id === t.id));
  });

  it('should getAllCompleted', async () => {
    const t = await tasksCore.insert(db, { title: 'AllComp', projectId: 'default' });
    await lifecycle.claim(db, 'default', t.id, agentZId);
    await lifecycle.complete(db, 'default', t.id, { agent: 'agent-z' });

    const rows = await lifecycle.getAllCompleted(db, 'default');
    assert.ok(rows.some((r) => r.id === t.id));
  });
});
