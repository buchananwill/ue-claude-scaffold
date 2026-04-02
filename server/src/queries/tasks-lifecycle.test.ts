import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import * as lifecycle from './tasks-lifecycle.js';
import * as tasksCore from './tasks-core.js';

describe('tasks-lifecycle queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;
  });

  after(async () => {
    await tdb.close();
  });

  it('should claim a pending task', async () => {
    const task = await tasksCore.insert(db, { title: 'Claimable' });
    const ok = await lifecycle.claim(db, task.id, 'agent-1');
    assert.equal(ok, true);
    const updated = await tasksCore.getById(db, task.id);
    assert.equal(updated?.status, 'claimed');
    assert.equal(updated?.claimedBy, 'agent-1');
    assert.ok(updated?.claimedAt);
  });

  it('should not claim a non-pending task', async () => {
    const task = await tasksCore.insert(db, { title: 'Already Claimed' });
    await lifecycle.claim(db, task.id, 'agent-1');
    const ok = await lifecycle.claim(db, task.id, 'agent-2');
    assert.equal(ok, false);
  });

  it('should update progress', async () => {
    const task = await tasksCore.insert(db, { title: 'Progressing' });
    await lifecycle.claim(db, task.id, 'agent-1');
    const ok = await lifecycle.updateProgress(db, task.id, 'Step 1 done');
    assert.equal(ok, true);
    const updated = await tasksCore.getById(db, task.id);
    assert.equal(updated?.status, 'in_progress');
    assert.ok(updated?.progressLog?.includes('Step 1 done'));
  });

  it('should append to progress log', async () => {
    const task = await tasksCore.insert(db, { title: 'Multi Progress' });
    await lifecycle.claim(db, task.id, 'agent-1');
    await lifecycle.updateProgress(db, task.id, 'First');
    await lifecycle.updateProgress(db, task.id, 'Second');
    const updated = await tasksCore.getById(db, task.id);
    assert.ok(updated?.progressLog?.includes('First'));
    assert.ok(updated?.progressLog?.includes('Second'));
  });

  it('should complete a claimed task', async () => {
    const task = await tasksCore.insert(db, { title: 'Completable' });
    await lifecycle.claim(db, task.id, 'agent-1');
    const ok = await lifecycle.complete(db, task.id, { agent: 'agent-1', summary: 'done' });
    assert.equal(ok, true);
    const updated = await tasksCore.getById(db, task.id);
    assert.equal(updated?.status, 'completed');
    assert.ok(updated?.completedAt);
    assert.deepEqual(updated?.result, { agent: 'agent-1', summary: 'done' });
  });

  it('should not complete a pending task', async () => {
    const task = await tasksCore.insert(db, { title: 'Not Completable' });
    const ok = await lifecycle.complete(db, task.id, {});
    assert.equal(ok, false);
  });

  it('should fail a claimed task', async () => {
    const task = await tasksCore.insert(db, { title: 'Failable' });
    await lifecycle.claim(db, task.id, 'agent-1');
    const ok = await lifecycle.fail(db, task.id, { error: 'oops' });
    assert.equal(ok, true);
    const updated = await tasksCore.getById(db, task.id);
    assert.equal(updated?.status, 'failed');
  });

  it('should release a claimed task', async () => {
    const task = await tasksCore.insert(db, { title: 'Releasable' });
    await lifecycle.claim(db, task.id, 'agent-1');
    const ok = await lifecycle.release(db, task.id);
    assert.equal(ok, true);
    const updated = await tasksCore.getById(db, task.id);
    assert.equal(updated?.status, 'pending');
    assert.equal(updated?.claimedBy, null);
  });

  it('should not release a pending task', async () => {
    const task = await tasksCore.insert(db, { title: 'Not Releasable' });
    const ok = await lifecycle.release(db, task.id);
    assert.equal(ok, false);
  });

  it('should reset a completed task', async () => {
    const task = await tasksCore.insert(db, { title: 'Resettable' });
    await lifecycle.claim(db, task.id, 'agent-1');
    await lifecycle.complete(db, task.id, { agent: 'agent-1' });
    const ok = await lifecycle.reset(db, task.id);
    assert.equal(ok, true);
    const updated = await tasksCore.getById(db, task.id);
    assert.equal(updated?.status, 'pending');
    assert.equal(updated?.claimedBy, null);
    assert.equal(updated?.result, null);
    assert.equal(updated?.progressLog, null);
  });

  it('should not reset a pending task', async () => {
    const task = await tasksCore.insert(db, { title: 'Not Resettable' });
    const ok = await lifecycle.reset(db, task.id);
    assert.equal(ok, false);
  });

  it('should integrate a completed task', async () => {
    const task = await tasksCore.insert(db, { title: 'Integratable' });
    await lifecycle.claim(db, task.id, 'agent-1');
    await lifecycle.complete(db, task.id, { agent: 'agent-1' });
    const ok = await lifecycle.integrate(db, task.id);
    assert.equal(ok, true);
    const updated = await tasksCore.getById(db, task.id);
    assert.equal(updated?.status, 'integrated');
  });

  it('should integrateBatch by agent', async () => {
    const t1 = await tasksCore.insert(db, { title: 'Batch 1' });
    const t2 = await tasksCore.insert(db, { title: 'Batch 2' });
    await lifecycle.claim(db, t1.id, 'agent-batch');
    await lifecycle.claim(db, t2.id, 'agent-batch');
    await lifecycle.complete(db, t1.id, { agent: 'agent-batch' });
    await lifecycle.complete(db, t2.id, { agent: 'agent-batch' });

    const result = await lifecycle.integrateBatch(db, 'agent-batch');
    assert.equal(result.count, 2);
    assert.ok(result.ids.includes(t1.id));
    assert.ok(result.ids.includes(t2.id));
  });

  it('should integrateAll', async () => {
    const t1 = await tasksCore.insert(db, { title: 'IntAll 1' });
    const t2 = await tasksCore.insert(db, { title: 'IntAll 2' });
    await lifecycle.claim(db, t1.id, 'a');
    await lifecycle.claim(db, t2.id, 'b');
    await lifecycle.complete(db, t1.id, { agent: 'a' });
    await lifecycle.complete(db, t2.id, { agent: 'b' });

    const result = await lifecycle.integrateAll(db);
    assert.ok(result.count >= 2);
    assert.ok(result.ids.includes(t1.id));
    assert.ok(result.ids.includes(t2.id));
  });

  it('should getCompletedByAgent', async () => {
    const t = await tasksCore.insert(db, { title: 'CompByAgent' });
    await lifecycle.claim(db, t.id, 'agent-q');
    await lifecycle.complete(db, t.id, { agent: 'agent-q' });

    const rows = await lifecycle.getCompletedByAgent(db, 'agent-q');
    assert.ok(rows.some((r) => r.id === t.id));
  });

  it('should getAllCompleted', async () => {
    const t = await tasksCore.insert(db, { title: 'AllComp' });
    await lifecycle.claim(db, t.id, 'agent-z');
    await lifecycle.complete(db, t.id, { agent: 'agent-z' });

    const rows = await lifecycle.getAllCompleted(db);
    assert.ok(rows.some((r) => r.id === t.id));
  });
});
