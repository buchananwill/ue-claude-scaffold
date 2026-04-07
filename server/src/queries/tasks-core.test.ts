import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import * as tasksCore from './tasks-core.js';

describe('tasks-core queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;
  });

  after(async () => {
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
    // Insert tasks with different priorities
    await tasksCore.insert(db, { title: 'Low', priority: 1, projectId: 'list-test' });
    await tasksCore.insert(db, { title: 'High', priority: 10, projectId: 'list-test' });
    await tasksCore.insert(db, { title: 'Mid', priority: 5, projectId: 'list-test' });

    const all = await tasksCore.list(db, { projectId: 'list-test' });
    assert.equal(all[0].title, 'High');
    assert.equal(all[1].title, 'Mid');
    assert.equal(all[2].title, 'Low');
  });

  it('should list with status filter', async () => {
    const all = await tasksCore.list(db, { status: ['pending'] });
    assert.ok(all.length > 0);
    for (const t of all) {
      assert.equal(t.status, 'pending');
    }
  });

  it('should list with pagination', async () => {
    const page1 = await tasksCore.list(db, { limit: 2, offset: 0 });
    const page2 = await tasksCore.list(db, { limit: 2, offset: 2 });
    assert.equal(page1.length, 2);
    assert.ok(page2.length > 0);
    assert.notEqual(page1[0].id, page2[0].id);
  });

  it('should count tasks', async () => {
    const c = await tasksCore.count(db, { status: ['pending'] });
    assert.ok(c > 0);
  });

  it('should count with project filter', async () => {
    const c = await tasksCore.count(db, { projectId: 'list-test' });
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
    // Should delete at least the ones we made (and others from earlier tests)
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
});
