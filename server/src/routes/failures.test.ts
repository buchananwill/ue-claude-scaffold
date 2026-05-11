import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import failuresPlugin from './failures.js';
import { tasks } from '../schema/tables.js';

async function insertFailedTask(
  db: DrizzleTestContext['db'],
  opts: {
    projectId: string;
    failureReason: string;
    completedAt?: Date;
    title?: string;
  },
): Promise<number> {
  const rows = await db.insert(tasks).values({
    projectId: opts.projectId,
    title: opts.title ?? 'failed-task',
    status: 'failed',
    failureReason: opts.failureReason,
    completedAt: opts.completedAt ?? new Date(),
  }).returning();
  return rows[0].id;
}

describe('failures routes', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(failuresPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  // ── /failures/reasons ────────────────────────────────────────────────

  it('rejects missing X-Project-Id with 400', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/failures/reasons' });
    assert.equal(res.statusCode, 400);
  });

  it('groups failure_reason for status=failed rows with example task IDs', async () => {
    // 2 cycle budget exhausted, 1 role_session_no_op
    const a = await insertFailedTask(ctx.db, {
      projectId: 'default', failureReason: 'review_cycle_budget_exhausted',
    });
    const b = await insertFailedTask(ctx.db, {
      projectId: 'default', failureReason: 'review_cycle_budget_exhausted',
    });
    const c = await insertFailedTask(ctx.db, {
      projectId: 'default', failureReason: 'role_session_no_op',
    });

    // A non-failed task should be ignored
    await ctx.db.insert(tasks).values({
      projectId: 'default',
      title: 'still pending',
      status: 'pending',
    });
    // A failed task without failure_reason should be ignored
    await ctx.db.insert(tasks).values({
      projectId: 'default',
      title: 'no-reason',
      status: 'failed',
      completedAt: new Date(),
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/failures/reasons',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const j = res.json();
    assert.equal(j.patterns.length, 2);

    const cycle = j.patterns.find((p: { failureReason: string }) => p.failureReason === 'review_cycle_budget_exhausted');
    assert.ok(cycle);
    assert.equal(cycle.count, 2);
    assert.equal(cycle.exampleTaskIds.length, 2);
    assert.ok(cycle.exampleTaskIds.includes(a));
    assert.ok(cycle.exampleTaskIds.includes(b));

    const noOp = j.patterns.find((p: { failureReason: string }) => p.failureReason === 'role_session_no_op');
    assert.ok(noOp, 'role_session_no_op group must be present');
    assert.equal(noOp.count, 1);
    assert.deepEqual(noOp.exampleTaskIds, [c]);
  });

  it('caps example task IDs at 3 and orders by completed_at DESC', async () => {
    const now = Date.now();
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await insertFailedTask(ctx.db, {
        projectId: 'default',
        failureReason: 'engineer_build_failure',
        completedAt: new Date(now - (5 - i) * 1000),
      });
      ids.push(id);
    }
    // ids[4] is the most recent.

    const res = await ctx.app.inject({
      method: 'GET', url: '/failures/reasons',
      headers: { 'x-project-id': 'default' },
    });
    const j = res.json();
    assert.equal(j.patterns.length, 1);
    assert.equal(j.patterns[0].count, 5);
    assert.equal(j.patterns[0].exampleTaskIds.length, 3);
    // Most recent three: ids[4], ids[3], ids[2]
    assert.deepEqual(j.patterns[0].exampleTaskIds, [ids[4], ids[3], ids[2]]);
  });

  it('does not leak across projects', async () => {
    await insertFailedTask(ctx.db, {
      projectId: 'proj-a',
      failureReason: 'reviewer_contradiction',
    });
    await insertFailedTask(ctx.db, {
      projectId: 'default',
      failureReason: 'arbitrator_escalated',
    });

    const aRes = await ctx.app.inject({
      method: 'GET', url: '/failures/reasons',
      headers: { 'x-project-id': 'proj-a' },
    });
    const aJ = aRes.json();
    assert.equal(aJ.patterns.length, 1);
    assert.equal(aJ.patterns[0].failureReason, 'reviewer_contradiction');

    const dRes = await ctx.app.inject({
      method: 'GET', url: '/failures/reasons',
      headers: { 'x-project-id': 'default' },
    });
    const dJ = dRes.json();
    assert.equal(dJ.patterns.length, 1);
    assert.equal(dJ.patterns[0].failureReason, 'arbitrator_escalated');
  });

  it('respects since window (excludes older failed tasks)', async () => {
    await insertFailedTask(ctx.db, {
      projectId: 'default',
      failureReason: 'review_cycle_budget_exhausted',
      completedAt: new Date('2020-01-01T00:00:00Z'),
    });

    const res = await ctx.app.inject({
      method: 'GET', url: '/failures/reasons?since=2024-01-01',
      headers: { 'x-project-id': 'default' },
    });
    const j = res.json();
    assert.equal(j.patterns.length, 0);
  });

  it('rejects unparseable since', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/failures/reasons?since=not-a-date',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 400);
  });
});
