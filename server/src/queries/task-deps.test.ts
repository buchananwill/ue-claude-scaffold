import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import * as taskDepsQ from './task-deps.js';
import * as tasksCore from './tasks-core.js';

describe('task-deps queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;
  let taskA: number;
  let taskB: number;
  let taskC: number;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;

    const a = await tasksCore.insert(db, { title: 'Task A', projectId: 'dep-proj' });
    const b = await tasksCore.insert(db, { title: 'Task B', projectId: 'dep-proj' });
    const c = await tasksCore.insert(db, { title: 'Task C', projectId: 'dep-proj' });
    taskA = a.id;
    taskB = b.id;
    taskC = c.id;
  });

  after(async () => {
    await tdb.close();
  });

  it('should insert a dependency', async () => {
    await taskDepsQ.insertDep(db, taskB, taskA); // B depends on A
    const deps = await taskDepsQ.getDepsForTask(db, taskB);
    assert.deepEqual(deps, [taskA]);
  });

  it('should be idempotent (INSERT OR IGNORE)', async () => {
    await taskDepsQ.insertDep(db, taskB, taskA); // should not throw
    const deps = await taskDepsQ.getDepsForTask(db, taskB);
    assert.equal(deps.length, 1);
  });

  it('should get incomplete blockers', async () => {
    // A is pending, so B is blocked
    const blockers = await taskDepsQ.getIncompleteBlockers(db, taskB);
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].id, taskA);
  });

  it('should not show completed deps as blockers', async () => {
    // Complete task A
    await db.execute(sql`UPDATE tasks SET status = 'completed', result = '{"agent":"agent-x"}'::jsonb WHERE id = ${taskA}`);
    const blockers = await taskDepsQ.getIncompleteBlockers(db, taskB);
    assert.equal(blockers.length, 0);
  });

  it('should find wrong-branch blockers', async () => {
    // A is completed by agent-x, check from agent-y perspective
    const wrongBranch = await taskDepsQ.getWrongBranchBlockers(db, taskB, 'agent-y');
    assert.equal(wrongBranch.length, 1);
    assert.equal(wrongBranch[0].id, taskA);
  });

  it('should not flag same-agent as wrong branch', async () => {
    const wrongBranch = await taskDepsQ.getWrongBranchBlockers(db, taskB, 'agent-x');
    assert.equal(wrongBranch.length, 0);
  });

  it('should delete deps for task', async () => {
    await taskDepsQ.insertDep(db, taskC, taskA);
    await taskDepsQ.insertDep(db, taskC, taskB);
    await taskDepsQ.deleteDepsForTask(db, taskC);
    const deps = await taskDepsQ.getDepsForTask(db, taskC);
    assert.equal(deps.length, 0);
  });
});
