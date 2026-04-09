import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import { tasks, files } from '../schema/tables.js';
import { sql } from 'drizzle-orm';
import * as coalesceQ from './coalesce.js';
import * as agentQ from './agents.js';

describe('coalesce queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;
  let pump1Id: string;
  let pump2Id: string;
  let single1Id: string;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;

    // Register agents via the query module to get proper UUIDs
    const p1 = await agentQ.register(db, { name: 'pump-1', worktree: '/tmp/p1', mode: 'pump', projectId: 'default', sessionToken: 'co-tok-p1' });
    const p2 = await agentQ.register(db, { name: 'pump-2', worktree: '/tmp/p2', mode: 'pump', projectId: 'default', sessionToken: 'co-tok-p2' });
    const s1 = await agentQ.register(db, { name: 'single-1', worktree: '/tmp/s1', mode: 'single', projectId: 'default', sessionToken: 'co-tok-s1' });
    pump1Id = p1.id;
    pump2Id = p2.id;
    single1Id = s1.id;

    // Seed tasks using agent UUIDs
    await db.insert(tasks).values([
      { title: 'Task A', status: 'claimed', claimedByAgentId: pump1Id, projectId: 'default', priority: 0, basePriority: 0 },
      { title: 'Task B', status: 'in_progress', claimedByAgentId: pump1Id, projectId: 'default', priority: 0, basePriority: 0 },
      { title: 'Task C', status: 'pending', projectId: 'default', priority: 0, basePriority: 0 },
      { title: 'Task D', status: 'completed', projectId: 'default', priority: 0, basePriority: 0 },
    ]);

    // Seed files using agent UUIDs
    await db.insert(files).values([
      { projectId: 'default', path: 'src/a.cpp', claimantAgentId: pump1Id, claimedAt: sql`now()` },
      { projectId: 'default', path: 'src/b.cpp', claimantAgentId: pump2Id, claimedAt: sql`now()` },
      { projectId: 'default', path: 'src/c.cpp', claimantAgentId: null, claimedAt: null },
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
    const count = await coalesceQ.countActiveTasksForAgent(db, 'default', pump1Id);
    assert.equal(count, 2);

    const count2 = await coalesceQ.countActiveTasksForAgent(db, 'default', pump2Id);
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
    const paths = await coalesceQ.getOwnedFiles(db, 'default', pump1Id);
    assert.equal(paths.length, 1);
    assert.equal(paths[0], 'src/a.cpp');
  });

  it('should get in-flight tasks', async () => {
    const inflight = await coalesceQ.getInFlightTasks(db, 'default');
    assert.equal(inflight.length, 2);
    assert.ok(inflight.every((t) => t.claimedByAgentId === pump1Id));
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
