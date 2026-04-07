import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import * as tasksCore from './tasks-core.js';

describe('tasks-core queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;

  beforeEach(async () => {
    tdb = await createTestDb();
    db = tdb.db;
  });

  afterEach(async () => {
    await tdb.close();
  });

  it('should insert a task and return it', async () => {
    const task = await tasksCore.insert(db, {
      title: 'Task 1',
      description: 'Do something',
      priority: 5,
      projectId: 'proj-a',
    });
    assert.ok(task);
    assert.ok(task.id);
    assert.equal(task.title, 'Task 1');
    assert.equal(task.description, 'Do something');
    assert.equal(task.priority, 5);
    assert.equal(task.basePriority, 5);
    assert.equal(task.status, 'pending');
    assert.equal(task.projectId, 'proj-a');
  });

  it('should get task by id', async () => {
    const inserted = await tasksCore.insert(db, { title: 'Task 2' });
    const found = await tasksCore.getById(db, inserted.id);
    assert.ok(found);
    assert.equal(found.title, 'Task 2');
  });

  it('should return null for unknown id', async () => {
    const found = await tasksCore.getById(db, 99999);
    assert.equal(found, null);
  });

  it('should list tasks with ordering', async () => {
    await tasksCore.insert(db, { title: 'Low', priority: 1, projectId: 'list-test' });
    await tasksCore.insert(db, { title: 'High', priority: 10, projectId: 'list-test' });
    await tasksCore.insert(db, { title: 'Mid', priority: 5, projectId: 'list-test' });

    const all = await tasksCore.list(db, { projectId: 'list-test' });
    assert.equal(all[0].title, 'High');
    assert.equal(all[1].title, 'Mid');
    assert.equal(all[2].title, 'Low');
  });

  it('should list with status filter', async () => {
    await tasksCore.insert(db, { title: 'Pending task', priority: 1 });
    const all = await tasksCore.list(db, { status: ['pending'] });
    assert.ok(all.length > 0);
    for (const t of all) {
      assert.equal(t.status, 'pending');
    }
  });

  it('should list with pagination', async () => {
    await tasksCore.insert(db, { title: 'A', priority: 3 });
    await tasksCore.insert(db, { title: 'B', priority: 2 });
    await tasksCore.insert(db, { title: 'C', priority: 1 });

    const page1 = await tasksCore.list(db, { limit: 2, offset: 0 });
    const page2 = await tasksCore.list(db, { limit: 2, offset: 2 });
    assert.equal(page1.length, 2);
    assert.ok(page2.length > 0);
    assert.notEqual(page1[0].id, page2[0].id);
  });

  it('should count tasks', async () => {
    await tasksCore.insert(db, { title: 'Count me' });
    const c = await tasksCore.count(db, { status: ['pending'] });
    assert.ok(c > 0);
  });

  it('should count with project filter', async () => {
    await tasksCore.insert(db, { title: 'A', projectId: 'count-test' });
    await tasksCore.insert(db, { title: 'B', projectId: 'count-test' });
    await tasksCore.insert(db, { title: 'C', projectId: 'count-test' });
    const c = await tasksCore.count(db, { projectId: 'count-test' });
    assert.equal(c, 3);
  });

  it('should patch a pending task', async () => {
    const task = await tasksCore.insert(db, { title: 'Patchable', priority: 1 });
    const ok = await tasksCore.patch(db, task.id, { title: 'Patched', priority: 10 });
    assert.equal(ok, true);
    const updated = await tasksCore.getById(db, task.id);
    assert.equal(updated?.title, 'Patched');
    assert.equal(updated?.priority, 10);
  });

  it('should not patch a non-pending task', async () => {
    const { sql: sqlTag } = await import('drizzle-orm');
    const task = await tasksCore.insert(db, { title: 'Will Claim' });
    await db.execute(sqlTag`UPDATE tasks SET status = 'claimed' WHERE id = ${task.id}`);
    const ok = await tasksCore.patch(db, task.id, { title: 'Should Fail' });
    assert.equal(ok, false);
  });

  it('should delete by status', async () => {
    await tasksCore.insert(db, { title: 'To Delete', projectId: 'del-test' });
    await tasksCore.insert(db, { title: 'To Delete 2', projectId: 'del-test' });
    const n = await tasksCore.deleteByStatus(db, 'pending');
    assert.ok(n >= 2);
  });

  it('should delete by id if not claimed/in_progress', async () => {
    const task = await tasksCore.insert(db, { title: 'Deletable' });
    const ok = await tasksCore.deleteById(db, task.id);
    assert.equal(ok, true);
    const gone = await tasksCore.getById(db, task.id);
    assert.equal(gone, null);
  });

  it('should not delete claimed task by id', async () => {
    const { sql: sqlTag } = await import('drizzle-orm');
    const task = await tasksCore.insert(db, { title: 'Claimed' });
    await db.execute(sqlTag`UPDATE tasks SET status = 'claimed' WHERE id = ${task.id}`);
    const ok = await tasksCore.deleteById(db, task.id);
    assert.equal(ok, false);
  });

  it('should default sort direction to asc when dir is omitted', async () => {
    await tasksCore.insert(db, { title: 'ZZZ', priority: 1 });
    await tasksCore.insert(db, { title: 'AAA', priority: 2 });

    // sort=title with no dir should default to asc
    const rows = await tasksCore.list(db, { sort: 'title' });
    assert.equal(rows[0].title, 'AAA');
    assert.equal(rows[1].title, 'ZZZ');
  });
});
