import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, insertTestAgent, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import * as taskFilesQ from './task-files.js';
import * as tasksCore from './tasks-core.js';

describe('task-files queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;
  let taskId: number;
  let agent1Id: string;
  let agent2Id: string;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;

    // Create agents (proj-f is seeded in test-utils DDL)
    agent1Id = await insertTestAgent(db, 'agent-1', 'proj-f');
    agent2Id = await insertTestAgent(db, 'agent-2', 'proj-f');

    // Create a task to link files to
    const task = await tasksCore.insert(db, {
      title: 'File Test Task',
      projectId: 'proj-f',
    });
    taskId = task.id;
  });

  after(async () => {
    await tdb.close();
  });

  it('should insert a file (idempotent)', async () => {
    await taskFilesQ.insertFile(db, 'proj-f', 'src/main.cpp');
    // Insert again — should not throw
    await taskFilesQ.insertFile(db, 'proj-f', 'src/main.cpp');
  });

  it('should link file to task', async () => {
    await taskFilesQ.insertFile(db, 'proj-f', 'src/utils.cpp');
    await taskFilesQ.linkFileToTask(db, taskId, 'src/main.cpp');
    await taskFilesQ.linkFileToTask(db, taskId, 'src/utils.cpp');
  });

  it('should get files for task', async () => {
    const files = await taskFilesQ.getFilesForTask(db, taskId);
    assert.ok(files.includes('src/main.cpp'));
    assert.ok(files.includes('src/utils.cpp'));
  });

  it('should claim files for agent (unclaimed)', async () => {
    const ok = await taskFilesQ.claimFilesForAgent(db, agent1Id, 'proj-f', 'src/main.cpp');
    assert.equal(ok, true);
  });

  it('should not claim already-claimed file', async () => {
    const ok = await taskFilesQ.claimFilesForAgent(db, agent2Id, 'proj-f', 'src/main.cpp');
    assert.equal(ok, false);
  });

  it('should get file conflicts for agent', async () => {
    const conflicts = await taskFilesQ.getFileConflicts(db, taskId, agent2Id);
    assert.ok(conflicts.length >= 1);
    assert.ok(conflicts.some((c) => c.path === 'src/main.cpp' && c.claimant === agent1Id));
  });

  it('should not show own files as conflicts', async () => {
    const conflicts = await taskFilesQ.getFileConflicts(db, taskId, agent1Id);
    // agent-1 owns src/main.cpp, so it should NOT be a conflict
    assert.ok(!conflicts.some((c) => c.path === 'src/main.cpp'));
  });

  it('should get all file locks for task (no exclusion)', async () => {
    const locks = await taskFilesQ.getFileConflicts(db, taskId);
    assert.ok(locks.some((l) => l.path === 'src/main.cpp'));
  });

  it('should delete files for task', async () => {
    await taskFilesQ.deleteFilesForTask(db, taskId);
    const files = await taskFilesQ.getFilesForTask(db, taskId);
    assert.equal(files.length, 0);
  });
});
