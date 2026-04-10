import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { createTestDb, insertTestAgent, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import * as tasksClaim from './tasks-claim.js';
import * as tasksCore from './tasks-core.js';
import * as taskFilesQ from './task-files.js';
import * as taskDepsQ from './task-deps.js';

describe('tasks-claim queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;
  });

  after(async () => {
    await tdb.close();
  });

  describe('claimNextCandidate', () => {
    // Scenario:
    // Task 1: priority 10, no files, no deps
    // Task 2: priority 5, depends on Task 1 (completed by agent-a)
    // Task 3: priority 8, has file claimed by agent-b (should be excluded for agent-a)
    // Task 4: priority 3, no files, no deps
    // Task 5: priority 5, depends on Task 6 (pending = unmet dep, excluded)
    // Task 6: priority 1, no deps
    let t1: number, t2: number, t3: number, t4: number, t5: number, t6: number;
    let agentAId: string, agentBId: string;

    before(async () => {
      const proj = 'claim-proj';
      agentAId = await insertTestAgent(db, 'agent-a', proj);
      agentBId = await insertTestAgent(db, 'agent-b', proj);

      const r1 = await tasksCore.insert(db, { title: 'T1 high prio', priority: 10, projectId: proj });
      const r2 = await tasksCore.insert(db, { title: 'T2 dep on T1', priority: 5, projectId: proj });
      const r3 = await tasksCore.insert(db, { title: 'T3 file conflict', priority: 8, projectId: proj });
      const r4 = await tasksCore.insert(db, { title: 'T4 low prio', priority: 3, projectId: proj });
      const r5 = await tasksCore.insert(db, { title: 'T5 blocked dep', priority: 5, projectId: proj });
      const r6 = await tasksCore.insert(db, { title: 'T6 lowest', priority: 1, projectId: proj });
      t1 = r1.id; t2 = r2.id; t3 = r3.id; t4 = r4.id; t5 = r5.id; t6 = r6.id;

      // T1 is completed by agent-a
      await db.execute(sql`UPDATE tasks SET status = 'completed', result = '{"agent":"agent-a"}'::jsonb WHERE id = ${t1}`);

      // T2 depends on T1 (completed by agent-a — so T2 is eligible for agent-a, gets affinity boost)
      await taskDepsQ.insertDep(db, t2, t1);

      // T3 has a file claimed by agent-b
      await taskFilesQ.insertFile(db, proj, 'conflicted.cpp');
      await taskFilesQ.linkFileToTask(db, t3, 'conflicted.cpp');
      await taskFilesQ.claimFilesForAgent(db, agentBId, proj, 'conflicted.cpp');

      // T5 depends on T6 (pending — unmet dep)
      await taskDepsQ.insertDep(db, t5, t6);

      // T4 has a file that needs a new lock
      await taskFilesQ.insertFile(db, proj, 'newfile.cpp');
      await taskFilesQ.linkFileToTask(db, t4, 'newfile.cpp');
    });

    it('should return candidates in correct order for agent-a', async () => {
      const candidates = await tasksClaim.claimNextCandidate(db, 'claim-proj', agentAId, 'agent-a');

      // Expected ordering for agent-a:
      // 1. T2: has dep completed by agent-a (affinity=0), 0 new locks, prio 5
      // 2. T6: no affinity (1), 0 new locks, prio 1
      // 3. T4: no affinity (1), 1 new lock, prio 3
      // Excluded: T1 (completed), T3 (file conflict with agent-b), T5 (dep on pending T6)

      assert.ok(candidates.length >= 3, `Expected >= 3 candidates, got ${candidates.length}`);

      // T2 should be first (affinity boost)
      assert.equal(candidates[0].id, t2, 'T2 should be first due to agent affinity');

      // T3 should NOT appear (file conflict for agent-a since agent-b holds the file)
      const hasT3 = candidates.some((c) => c.id === t3);
      assert.equal(hasT3, false, 'T3 should be excluded due to file conflict');

      // T1 should NOT appear (completed)
      const hasT1 = candidates.some((c) => c.id === t1);
      assert.equal(hasT1, false, 'T1 should be excluded (completed)');

      // T5 should NOT appear (dep on pending T6)
      const hasT5 = candidates.some((c) => c.id === t5);
      assert.equal(hasT5, false, 'T5 should be excluded (unmet dep on T6)');
    });

    it('should allow agent-b to see T3 (owns the file)', async () => {
      const candidates = await tasksClaim.claimNextCandidate(db, 'claim-proj', agentBId, 'agent-b');
      const hasT3 = candidates.some((c) => c.id === t3);
      assert.ok(hasT3, 'T3 should be available to agent-b (owns the file)');
    });
  });

  describe('count functions', () => {
    it('should count pending tasks', async () => {
      // From the scenario above, pending tasks in claim-proj: T2, T3, T4, T5, T6
      const c = await tasksClaim.countPending(db, 'claim-proj');
      assert.equal(c, 5);
    });

    it('should count file-blocked tasks', async () => {
      // T3 is blocked for agent-a (file conflict from agent-b)
      // countBlocked takes agentId (UUID), not name
      const agentARow = await db.execute(sql`SELECT id FROM agents WHERE name = 'agent-a' AND project_id = 'claim-proj'`);
      const agentAId = (agentARow.rows[0] as { id: string }).id;
      const c = await tasksClaim.countBlocked(db, 'claim-proj', agentAId);
      assert.equal(c, 1);
    });

    it('should count dep-blocked tasks', async () => {
      // T5 has unmet dep (T6 is pending)
      // T2's dep (T1) is completed by agent-a — for agent-a, T2 is NOT dep-blocked
      const c = await tasksClaim.countDepBlocked(db, 'claim-proj', 'agent-a');
      assert.equal(c, 1); // T5

      // For agent-b, T2's dep (T1) is completed by agent-a, not agent-b — so T2 IS dep-blocked
      const c2 = await tasksClaim.countDepBlocked(db, 'claim-proj', 'agent-b');
      assert.equal(c2, 2); // T2 and T5
    });
  });
});
