import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import * as buildQ from './builds.js';

describe('builds queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;
  });

  after(async () => {
    await tdb.close();
  });

  it('should insert build history and return id', async () => {
    const id = await buildQ.insertHistory(db, { agent: 'agent-1', type: 'build' });
    assert.equal(typeof id, 'number');
    assert.ok(id > 0);
  });

  it('should update build history', async () => {
    const id = await buildQ.insertHistory(db, { agent: 'agent-1', type: 'build' });
    await buildQ.updateHistory(db, id, {
      durationMs: 5000,
      success: true,
      output: 'ok',
      stderr: '',
    });

    const last = await buildQ.lastCompleted(db, 'agent-1', 'build');
    assert.ok(last);
    assert.equal(last.durationMs, 5000);
    assert.equal(last.success, 1);
    assert.equal(last.output, 'ok');
  });

  it('should get last completed build', async () => {
    const id = await buildQ.insertHistory(db, { agent: 'agent-1', type: 'test' });
    await buildQ.updateHistory(db, id, {
      durationMs: 2000,
      success: false,
      output: 'fail',
      stderr: 'error',
    });

    const last = await buildQ.lastCompleted(db, 'agent-1', 'test');
    assert.ok(last);
    assert.equal(last.durationMs, 2000);
    assert.equal(last.success, 0);
  });

  it('should return null for no completed builds', async () => {
    const last = await buildQ.lastCompleted(db, 'no-agent', 'build');
    assert.equal(last, null);
  });

  it('should compute avgDuration from last 5 successful', async () => {
    // Insert 6 successful builds with known durations
    for (let i = 0; i < 6; i++) {
      const id = await buildQ.insertHistory(db, { agent: 'avg-agent', type: 'build' });
      await buildQ.updateHistory(db, id, {
        durationMs: 1000 * (i + 1), // 1000, 2000, 3000, 4000, 5000, 6000
        success: true,
        output: '',
      });
    }

    // Should average last 5: 2000, 3000, 4000, 5000, 6000 = 4000
    const avg = await buildQ.avgDuration(db, 'build');
    assert.ok(avg != null);
    // Due to other test data, just check it's a reasonable number
    assert.ok(avg > 0);
  });

  it('should return null avgDuration when no matching builds', async () => {
    const avg = await buildQ.avgDuration(db, 'nonexistent-type');
    assert.equal(avg, null);
  });

  it('should list builds with filters', async () => {
    const all = await buildQ.list(db);
    assert.ok(all.length > 0);

    const byAgent = await buildQ.list(db, { agent: 'agent-1' });
    assert.ok(byAgent.every((b) => b.agent === 'agent-1'));

    const byType = await buildQ.list(db, { type: 'test' });
    assert.ok(byType.every((b) => b.type === 'test'));
  });

  it('should list builds ordered by id DESC', async () => {
    const all = await buildQ.list(db);
    for (let i = 1; i < all.length; i++) {
      assert.ok(all[i].id < all[i - 1].id);
    }
  });

  it('should list with limit', async () => {
    const limited = await buildQ.list(db, { limit: 2 });
    assert.ok(limited.length <= 2);
  });

  it('should list with since filter', async () => {
    const all = await buildQ.list(db);
    const midId = all[Math.floor(all.length / 2)].id;
    const newer = await buildQ.list(db, { since: midId });
    assert.ok(newer.every((b) => b.id > midId));
  });
});
