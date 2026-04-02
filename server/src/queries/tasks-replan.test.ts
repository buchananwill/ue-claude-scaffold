import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import * as replan from './tasks-replan.js';
import * as tasksCore from './tasks-core.js';
import * as taskDepsQ from './task-deps.js';

describe('tasks-replan queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;
  let tPending: number;
  let tClaimed: number;
  let tCompleted: number;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;

    const r1 = await tasksCore.insert(db, { title: 'Pending', priority: 5, projectId: 'replan' });
    const r2 = await tasksCore.insert(db, { title: 'Claimed', priority: 3, projectId: 'replan' });
    const r3 = await tasksCore.insert(db, { title: 'Completed', priority: 1, projectId: 'replan' });
    tPending = r1.id;
    tClaimed = r2.id;
    tCompleted = r3.id;

    await db.execute(sql`UPDATE tasks SET status = 'claimed' WHERE id = ${tClaimed}`);
    await db.execute(sql`UPDATE tasks SET status = 'completed' WHERE id = ${tCompleted}`);

    // Dep: pending depends on claimed
    await taskDepsQ.insertDep(db, tPending, tClaimed);
  });

  after(async () => {
    await tdb.close();
  });

  it('should get non-terminal tasks', async () => {
    const rows = await replan.getNonTerminalTasks(db);
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes(tPending));
    assert.ok(ids.includes(tClaimed));
    assert.ok(!ids.includes(tCompleted));
  });

  it('should get non-terminal deps', async () => {
    const rows = await replan.getNonTerminalDeps(db);
    // pending -> claimed: both non-terminal
    assert.ok(rows.some((r) => r.taskId === tPending && r.dependsOn === tClaimed));
  });

  it('should mark cycle', async () => {
    const t = await tasksCore.insert(db, { title: 'Cycle' });
    await replan.markCycle(db, t.id);
    const updated = await tasksCore.getById(db, t.id);
    assert.equal(updated?.status, 'cycle');
  });

  it('should set priority', async () => {
    await replan.setPriority(db, tPending, 99);
    const updated = await tasksCore.getById(db, tPending);
    assert.equal(updated?.priority, 99);
  });
});
