import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import { agents, tasks, files } from '../schema/tables.js';
import { sql } from 'drizzle-orm';
import * as coalesceQ from './coalesce.js';

describe('coalesce queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;

    // Seed agents
    await db.insert(agents).values([
      { name: 'pump-1', worktree: '/tmp/p1', status: 'idle', mode: 'pump', projectId: 'default' },
      { name: 'pump-2', worktree: '/tmp/p2', status: 'idle', mode: 'pump', projectId: 'default' },
      { name: 'single-1', worktree: '/tmp/s1', status: 'idle', mode: 'single', projectId: 'default' },
    ]);

    // Seed tasks
    await db.insert(tasks).values([
      { title: 'Task A', status: 'claimed', claimedBy: 'pump-1', projectId: 'default', priority: 0, basePriority: 0 },
      { title: 'Task B', status: 'in_progress', claimedBy: 'pump-1', projectId: 'default', priority: 0, basePriority: 0 },
      { title: 'Task C', status: 'pending', projectId: 'default', priority: 0, basePriority: 0 },
      { title: 'Task D', status: 'completed', projectId: 'default', priority: 0, basePriority: 0 },
    ]);

    // Seed files
    await db.insert(files).values([
      { projectId: 'default', path: 'src/a.cpp', claimant: 'pump-1', claimedAt: sql`now()` },
      { projectId: 'default', path: 'src/b.cpp', claimant: 'pump-2', claimedAt: sql`now()` },
      { projectId: 'default', path: 'src/c.cpp', claimant: null, claimedAt: null },
    ]);
  });

  after(async () => {
    await tdb.close();
  });

  it('should count active tasks', async () => {
    const count = await coalesceQ.countActiveTasks(db, 'default');
    assert.equal(count, 2);
  });

  it('should count active tasks for agent', async () => {
    const count = await coalesceQ.countActiveTasksForAgent(db, 'pump-1');
    assert.equal(count, 2);

    const count2 = await coalesceQ.countActiveTasksForAgent(db, 'pump-2');
    assert.equal(count2, 0);
  });

  it('should count pending tasks', async () => {
    const count = await coalesceQ.countPendingTasks(db, 'default');
    assert.equal(count, 1);
  });

  it('should count claimed files', async () => {
    const count = await coalesceQ.countClaimedFiles(db, 'default');
    assert.equal(count, 2);
  });

  it('should get owned files for agent', async () => {
    const paths = await coalesceQ.getOwnedFiles(db, 'pump-1', 'default');
    assert.equal(paths.length, 1);
    assert.equal(paths[0], 'src/a.cpp');
  });

  it('should get in-flight tasks', async () => {
    const inflight = await coalesceQ.getInFlightTasks(db, 'default');
    assert.equal(inflight.length, 2);
    assert.ok(inflight.every((t) => t.claimedBy === 'pump-1'));
  });

  it('should pause pump agents', async () => {
    await coalesceQ.pausePumpAgents(db, 'default');
    const paused = await coalesceQ.getPausedAgentNames(db, 'default');
    assert.equal(paused.length, 2);
    assert.ok(paused.includes('pump-1'));
    assert.ok(paused.includes('pump-2'));
  });

  it('should release all files', async () => {
    await coalesceQ.releaseAllFiles(db, 'default');
    const count = await coalesceQ.countClaimedFiles(db, 'default');
    assert.equal(count, 0);
  });

  it('should resume paused agents', async () => {
    await coalesceQ.resumePausedAgents(db, 'default');
    const paused = await coalesceQ.getPausedAgentNames(db, 'default');
    assert.equal(paused.length, 0);
  });
});
