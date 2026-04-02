import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import { tasks } from '../schema/tables.js';
import * as compositionQ from './composition.js';
import { getFilesForTask } from './task-files.js';
import { getDepsForTask } from './task-deps.js';
import * as fileQ from './files.js';

describe('composition queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;
  let taskId: number;
  let depTaskId: number;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;

    // Create tasks to reference
    const rows = await db
      .insert(tasks)
      .values([
        { title: 'Main task', status: 'pending', priority: 0, basePriority: 0, projectId: 'default' },
        { title: 'Dep task', status: 'completed', priority: 0, basePriority: 0, projectId: 'default' },
      ])
      .returning();
    taskId = rows[0].id;
    depTaskId = rows[1].id;
  });

  after(async () => {
    await tdb.close();
  });

  it('should link files to task', async () => {
    await compositionQ.linkFilesToTask(db, taskId, ['src/main.cpp', 'src/utils.cpp'], 'default');

    const linkedFiles = await getFilesForTask(db, taskId);
    assert.equal(linkedFiles.length, 2);
    assert.ok(linkedFiles.includes('src/main.cpp'));
    assert.ok(linkedFiles.includes('src/utils.cpp'));
  });

  it('should link files and claim for agent', async () => {
    await compositionQ.linkFilesToTask(db, taskId, ['src/render.cpp'], 'default', 'agent-1');

    const linkedFiles = await getFilesForTask(db, taskId);
    assert.ok(linkedFiles.includes('src/render.cpp'));

    // Check file was claimed
    const allFiles = await fileQ.list(db, 'default', { claimant: 'agent-1' });
    assert.ok(allFiles.some((f) => f.path === 'src/render.cpp'));
  });

  it('should link deps to task', async () => {
    await compositionQ.linkDepsToTask(db, taskId, [depTaskId]);

    const deps = await getDepsForTask(db, taskId);
    assert.equal(deps.length, 1);
    assert.equal(deps[0], depTaskId);
  });
});
