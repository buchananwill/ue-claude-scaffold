import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
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

  /** Helper: drive a task to 'complete' through the new FSM at the SQL level. */
  async function markComplete(taskId: number, agentName: string): Promise<void> {
    await db.execute(sql`
      UPDATE tasks
         SET status = 'complete',
             completed_at = now(),
             result = ${JSON.stringify({ agent: agentName })}::jsonb
       WHERE id = ${taskId}
    `);
  }

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

  it('should release a task in an FSM mid-state (engineering, reviewing)', async () => {
    // Step 5 of the FSM cutover lets the abnormal-exit branch in run-claude.sh
    // POST /tasks/:id/release to hand work back when a container dies. That
    // path must succeed for tasks already past 'claimed' — otherwise an agent
    // killed mid-engineering would strand the task.
    for (const fsmStatus of ['engineering', 'reviewing'] as const) {
      const task = await tasksCore.insert(db, { title: `Mid ${fsmStatus}`, projectId: 'default' });
      await lifecycle.claim(db, 'default', task.id, agent1Id);
      await db.execute(sql`UPDATE tasks SET status = ${fsmStatus} WHERE id = ${task.id}`);
      const ok = await lifecycle.release(db, 'default', task.id);
      assert.equal(ok, true, `release should succeed for status=${fsmStatus}`);
      const updated = await tasksCore.getById(db, task.id);
      assert.equal(updated?.status, 'pending');
      assert.equal(updated?.claimedByAgentId, null);
    }
  });

  it('should not release a task in a terminal status (complete, failed, integrated)', async () => {
    for (const terminal of ['complete', 'failed', 'integrated'] as const) {
      const task = await tasksCore.insert(db, { title: `Terminal ${terminal}`, projectId: 'default' });
      await db.execute(sql`UPDATE tasks SET status = ${terminal} WHERE id = ${task.id}`);
      const ok = await lifecycle.release(db, 'default', task.id);
      assert.equal(ok, false, `release should no-op for status=${terminal}`);
      const after = await tasksCore.getById(db, task.id);
      assert.equal(after?.status, terminal);
    }
  });

  it('should reset a complete task', async () => {
    const task = await tasksCore.insert(db, { title: 'Resettable', projectId: 'default' });
    await lifecycle.claim(db, 'default', task.id, agent1Id);
    await markComplete(task.id, 'agent-1');
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

  it('should integrate a complete task', async () => {
    const task = await tasksCore.insert(db, { title: 'Integratable', projectId: 'default' });
    await lifecycle.claim(db, 'default', task.id, agent1Id);
    await markComplete(task.id, 'agent-1');
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
    await markComplete(t1.id, 'agent-batch');
    await markComplete(t2.id, 'agent-batch');

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
    await markComplete(t1.id, 'a');
    await markComplete(t2.id, 'b');

    const result = await lifecycle.integrateAll(db, 'default');
    assert.ok(result.count >= 2);
    assert.ok(result.ids.includes(t1.id));
    assert.ok(result.ids.includes(t2.id));
  });

  it('should getCompletedByAgent', async () => {
    const t = await tasksCore.insert(db, { title: 'CompByAgent', projectId: 'default' });
    await lifecycle.claim(db, 'default', t.id, agentQId);
    await markComplete(t.id, 'agent-q');

    const rows = await lifecycle.getCompletedByAgent(db, 'default', agentQId);
    assert.ok(rows.some((r) => r.id === t.id));
  });

  it('should getAllCompleted', async () => {
    const t = await tasksCore.insert(db, { title: 'AllComp', projectId: 'default' });
    await lifecycle.claim(db, 'default', t.id, agentZId);
    await markComplete(t.id, 'agent-z');

    const rows = await lifecycle.getAllCompleted(db, 'default');
    assert.ok(rows.some((r) => r.id === t.id));
  });
});
