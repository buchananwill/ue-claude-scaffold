import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { createTestConfig, registerAgent } from '../test-helper.js';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import tasksPlugin from './tasks.js';
import agentsPlugin from './agents.js';

describe('tasks-lifecycle routes', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    const config = createTestConfig();
    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(tasksPlugin, { config });
    await registerAgent(ctx.app, 'agent-1');
    await registerAgent(ctx.app, 'agent-2');
    await registerAgent(ctx.app, 'nobody');
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  // ── helpers ───────────────────────────────────────────────────────────

  /** Create a task and return its id. */
  async function createTask(title = 'T'): Promise<number> {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title },
    });
    return post.json().id as number;
  }

  /** Claim a task as `agent-1`, leaving it in 'claimed'. */
  async function claim(id: number, agent = 'agent-1'): Promise<void> {
    const r = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-agent-name': agent },
    });
    assert.equal(r.statusCode, 200, `claim failed: ${r.body}`);
  }

  async function transition(
    id: number,
    body: { to: string; payload?: Record<string, unknown> },
    headers: Record<string, string> = { 'x-project-id': 'default' },
  ) {
    return ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/transition`,
      payload: body,
      headers,
    });
  }

  async function getTask(id: number): Promise<Record<string, unknown>> {
    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    return get.json() as Record<string, unknown>;
  }

  /** Read the FSM-only fields directly from the DB (not exposed by GET /tasks). */
  async function getFsmRow(id: number): Promise<{
    status: string;
    review_cycle_count: number;
    reviewer_verdicts: Record<string, string>;
    build_status: string;
    commit_sha: string | null;
    latest_review_path: string | null;
    arbitration_pending_trigger: string | null;
    failure_reason: string | null;
    failure_detail: string | null;
  }> {
    const result = await ctx.db.execute(sql`
      SELECT status, review_cycle_count, reviewer_verdicts, build_status, commit_sha,
             latest_review_path, arbitration_pending_trigger, failure_reason, failure_detail
        FROM tasks
       WHERE id = ${id}
    `);
    type FsmRowShape = {
      status: string;
      review_cycle_count: number;
      reviewer_verdicts: Record<string, string>;
      build_status: string;
      commit_sha: string | null;
      latest_review_path: string | null;
      arbitration_pending_trigger: string | null;
      failure_reason: string | null;
      failure_detail: string | null;
    };
    const rows = (result as unknown as { rows: FsmRowShape[] }).rows;
    return rows[0];
  }

  /**
   * Drive a task from `pending` up to `reviewing` with one verdict slot
   * already declared (so completion gating has something to gate on). Returns
   * the task id.
   */
  async function driveToReviewing(): Promise<number> {
    const id = await createTask('drive-to-reviewing');
    await claim(id);
    const r1 = await transition(id, { to: 'engineering' });
    assert.equal(r1.statusCode, 200, r1.body);
    const r2 = await transition(id, {
      to: 'built',
      payload: { buildStatus: 'clean', commitSha: 'sha-1' },
    });
    assert.equal(r2.statusCode, 200, r2.body);
    const r3 = await transition(id, { to: 'reviewing' });
    assert.equal(r3.statusCode, 200, r3.body);
    return id;
  }

  // ── 1. claimed → engineering ──────────────────────────────────────────

  it('claimed → engineering succeeds', async () => {
    const id = await createTask();
    await claim(id);

    const res = await transition(id, { to: 'engineering' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().status, 'engineering');

    const row = await getFsmRow(id);
    assert.equal(row.status, 'engineering');
  });

  // ── 2. engineering → built (with payload) ─────────────────────────────

  it('engineering → built with buildStatus + commitSha sets columns', async () => {
    const id = await createTask();
    await claim(id);
    await transition(id, { to: 'engineering' });

    const res = await transition(id, {
      to: 'built',
      payload: { buildStatus: 'clean', commitSha: 'abc123' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().status, 'built');

    const row = await getFsmRow(id);
    assert.equal(row.build_status, 'clean');
    assert.equal(row.commit_sha, 'abc123');
  });

  it('engineering → built returns 400 when commitSha missing', async () => {
    const id = await createTask();
    await claim(id);
    await transition(id, { to: 'engineering' });

    const res = await transition(id, { to: 'built', payload: { buildStatus: 'clean' } });
    assert.equal(res.statusCode, 400);
  });

  it('engineering → built returns 400 when buildStatus missing', async () => {
    const id = await createTask();
    await claim(id);
    await transition(id, { to: 'engineering' });

    const res = await transition(id, { to: 'built', payload: { commitSha: 'abc' } });
    assert.equal(res.statusCode, 400);
  });

  it('engineering → built returns 400 when buildStatus is out of enum', async () => {
    const id = await createTask();
    await claim(id);
    await transition(id, { to: 'engineering' });

    const res = await transition(id, {
      to: 'built',
      payload: { buildStatus: 'bogus', commitSha: 'abc' },
    });
    assert.equal(res.statusCode, 400);
  });

  // ── 3. built → reviewing resets reviewerVerdicts ──────────────────────

  it('built → reviewing resets reviewerVerdicts to {}', async () => {
    const id = await createTask();
    await claim(id);
    await transition(id, { to: 'engineering' });
    await transition(id, {
      to: 'built',
      payload: { buildStatus: 'clean', commitSha: 'sha' },
    });

    // Pre-seed verdicts to prove the reset is deliberate
    await ctx.db.execute(sql`
      UPDATE tasks SET reviewer_verdicts = '{"safety":"approve"}'::jsonb WHERE id = ${id}
    `);

    const res = await transition(id, { to: 'reviewing' });
    assert.equal(res.statusCode, 200, res.body);

    const row = await getFsmRow(id);
    assert.equal(row.status, 'reviewing');
    assert.deepEqual(row.reviewer_verdicts, {});
  });

  // ── 4. reviewing → reviewing accumulates verdicts (single-key merge) ─

  it('three reviewing→reviewing self-loops accumulate per-reviewer verdicts', async () => {
    const id = await driveToReviewing();

    const r1 = await transition(id, {
      to: 'reviewing',
      payload: { reviewerRole: 'safety', verdict: 'approve' },
    });
    assert.equal(r1.statusCode, 200, r1.body);

    const r2 = await transition(id, {
      to: 'reviewing',
      payload: { reviewerRole: 'correctness', verdict: 'approve' },
    });
    assert.equal(r2.statusCode, 200, r2.body);

    const r3 = await transition(id, {
      to: 'reviewing',
      payload: { reviewerRole: 'style', verdict: 'out_of_scope' },
    });
    assert.equal(r3.statusCode, 200, r3.body);

    const row = await getFsmRow(id);
    assert.equal(row.status, 'reviewing');
    assert.deepEqual(row.reviewer_verdicts, {
      safety: 'approve',
      correctness: 'approve',
      style: 'out_of_scope',
    });
  });

  it('reviewing → reviewing returns 400 when reviewerRole missing', async () => {
    const id = await driveToReviewing();
    const res = await transition(id, {
      to: 'reviewing',
      payload: { verdict: 'approve' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('reviewing → reviewing returns 400 when verdict missing', async () => {
    const id = await driveToReviewing();
    const res = await transition(id, {
      to: 'reviewing',
      payload: { reviewerRole: 'safety' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('reviewing → reviewing returns 400 when verdict is out of enum', async () => {
    const id = await driveToReviewing();
    const res = await transition(id, {
      to: 'reviewing',
      payload: { reviewerRole: 'safety', verdict: 'bogus' },
    });
    assert.equal(res.statusCode, 400);
  });

  // ── 5. reviewing → complete only when all reviewers clear ─────────────

  it('reviewing → complete succeeds when all declared reviewers approve/out_of_scope', async () => {
    const id = await driveToReviewing();
    await transition(id, {
      to: 'reviewing',
      payload: { reviewerRole: 'safety', verdict: 'approve' },
    });
    await transition(id, {
      to: 'reviewing',
      payload: { reviewerRole: 'correctness', verdict: 'out_of_scope' },
    });

    const res = await transition(id, { to: 'complete' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().status, 'complete');

    const row = await getFsmRow(id);
    assert.equal(row.status, 'complete');
  });

  it('reviewing → complete returns 409 when no verdicts present', async () => {
    const id = await driveToReviewing();

    const res = await transition(id, { to: 'complete' });
    assert.equal(res.statusCode, 409);
  });

  it('reviewing → complete returns 409 when a reviewer requested changes', async () => {
    const id = await driveToReviewing();
    await transition(id, {
      to: 'reviewing',
      payload: { reviewerRole: 'safety', verdict: 'approve' },
    });
    await transition(id, {
      to: 'reviewing',
      payload: { reviewerRole: 'correctness', verdict: 'request_changes' },
    });

    const res = await transition(id, { to: 'complete' });
    assert.equal(res.statusCode, 409);
  });

  // ── 6. invalid transitions return 409 ─────────────────────────────────

  it('pending → engineering returns 409 (skips claimed)', async () => {
    const id = await createTask();
    const res = await transition(id, { to: 'engineering' });
    assert.equal(res.statusCode, 409);
  });

  it('claimed → built returns 409', async () => {
    const id = await createTask();
    await claim(id);
    const res = await transition(id, {
      to: 'built',
      payload: { buildStatus: 'clean', commitSha: 'abc' },
    });
    assert.equal(res.statusCode, 409);
  });

  // ── 7. cycle-budget routing ───────────────────────────────────────────

  it('reviewing → revising reroutes to arbitrating when budget exhausted', async () => {
    const id = await driveToReviewing();
    // Push reviewCycleCount up to budget (5). We must use a SQL set rather
    // than driving the transitions because each successful revising raises
    // the count by one — we want the *next* revising to be the one that
    // exceeds the budget.
    await ctx.db.execute(sql`
      UPDATE tasks SET review_cycle_count = 5 WHERE id = ${id}
    `);

    const res = await transition(id, {
      to: 'revising',
      payload: { latestReviewPath: 'reviews/cycle-6/' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().status, 'arbitrating');

    const row = await getFsmRow(id);
    assert.equal(row.status, 'arbitrating');
    assert.equal(row.arbitration_pending_trigger, 'review_cycle_budget_exhausted');
    assert.equal(row.review_cycle_count, 6);
  });

  it('reviewing → revising under budget proceeds to revising and increments count', async () => {
    const id = await driveToReviewing();
    const res = await transition(id, {
      to: 'revising',
      payload: { latestReviewPath: 'reviews/cycle-1/' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().status, 'revising');

    const row = await getFsmRow(id);
    assert.equal(row.status, 'revising');
    assert.equal(row.review_cycle_count, 1);
    assert.equal(row.latest_review_path, 'reviews/cycle-1/');
  });

  it('revising → engineering succeeds', async () => {
    const id = await driveToReviewing();
    await transition(id, {
      to: 'revising',
      payload: { latestReviewPath: 'reviews/cycle-1/' },
    });

    const res = await transition(id, { to: 'engineering' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().status, 'engineering');
  });

  // ── 8. engineering → arbitrating (reviewer_contradiction) ─────────────

  it('engineering → arbitrating with reviewer_contradiction trigger succeeds', async () => {
    const id = await createTask();
    await claim(id);
    await transition(id, { to: 'engineering' });

    const res = await transition(id, {
      to: 'arbitrating',
      payload: {
        trigger: 'reviewer_contradiction',
        contradiction: { findingIds: [1, 2], notes: 'conflicting reads' },
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().status, 'arbitrating');

    const row = await getFsmRow(id);
    assert.equal(row.arbitration_pending_trigger, 'reviewer_contradiction');
  });

  it('engineering → arbitrating returns 400 with cycle-budget trigger', async () => {
    const id = await createTask();
    await claim(id);
    await transition(id, { to: 'engineering' });

    const res = await transition(id, {
      to: 'arbitrating',
      payload: { trigger: 'review_cycle_budget_exhausted' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('engineering → arbitrating returns 400 when trigger missing', async () => {
    const id = await createTask();
    await claim(id);
    await transition(id, { to: 'engineering' });

    const res = await transition(id, { to: 'arbitrating', payload: {} });
    assert.equal(res.statusCode, 400);
  });

  // ── 9. arbitration uniqueness ─────────────────────────────────────────

  it('second engineering → arbitrating with same trigger returns 409', async () => {
    const id = await createTask();
    await claim(id);
    await transition(id, { to: 'engineering' });
    const r1 = await transition(id, {
      to: 'arbitrating',
      payload: {
        trigger: 'reviewer_contradiction',
        contradiction: { findingIds: [1, 2], notes: 'first run' },
      },
    });
    assert.equal(r1.statusCode, 200, r1.body);

    // Insert an arbitrationRuns row for the same (task, trigger) to simulate
    // the arbitrator having posted a ruling. The next attempt to enter
    // arbitrating for the same trigger must fail with 409.
    await ctx.db.execute(sql`
      INSERT INTO arbitration_runs (task_id, trigger, ruling, ruling_markdown, contradiction_resolution)
      VALUES (${id}, 'reviewer_contradiction', 'rule', 'first ruling',
              '{"upheld":1,"retired":2}'::jsonb)
    `);

    // Drive back to engineering so the next transition is again valid by FSM
    // shape; only the uniqueness check should reject it.
    await ctx.db.execute(sql`
      UPDATE tasks SET status = 'engineering', arbitration_pending_trigger = NULL WHERE id = ${id}
    `);

    const r2 = await transition(id, {
      to: 'arbitrating',
      payload: {
        trigger: 'reviewer_contradiction',
        contradiction: { findingIds: [3, 4], notes: 'second run' },
      },
    });
    assert.equal(r2.statusCode, 409);
  });

  it('cycle-budget reroute returns 409 when an arbitration row already exists for the same trigger', async () => {
    const id = await driveToReviewing();
    await ctx.db.execute(sql`
      UPDATE tasks SET review_cycle_count = 5 WHERE id = ${id}
    `);
    // Pre-existing arbitration for the same trigger — the reroute must
    // recognise it and reject rather than entering arbitrating again.
    await ctx.db.execute(sql`
      INSERT INTO arbitration_runs (task_id, trigger, ruling, ruling_markdown)
      VALUES (${id}, 'review_cycle_budget_exhausted', 'escalate', 'previously escalated')
    `);

    const res = await transition(id, {
      to: 'revising',
      payload: { latestReviewPath: 'reviews/cycle-6/' },
    });
    assert.equal(res.statusCode, 409);
  });

  // ── 10. transitions out of arbitrating ────────────────────────────────

  it('arbitrating → complete succeeds and clears the pending trigger', async () => {
    const id = await createTask();
    await claim(id);
    await transition(id, { to: 'engineering' });
    await transition(id, {
      to: 'arbitrating',
      payload: {
        trigger: 'reviewer_contradiction',
        contradiction: { findingIds: [1, 2], notes: 'x' },
      },
    });

    const res = await transition(id, { to: 'complete' });
    assert.equal(res.statusCode, 200, res.body);

    const row = await getFsmRow(id);
    assert.equal(row.status, 'complete');
    assert.equal(row.arbitration_pending_trigger, null);
  });

  it('arbitrating → revising succeeds and clears the pending trigger', async () => {
    const id = await createTask();
    await claim(id);
    await transition(id, { to: 'engineering' });
    await transition(id, {
      to: 'arbitrating',
      payload: {
        trigger: 'reviewer_contradiction',
        contradiction: { findingIds: [1, 2], notes: 'x' },
      },
    });

    const res = await transition(id, {
      to: 'revising',
      payload: { latestReviewPath: 'reviews/arb/' },
    });
    assert.equal(res.statusCode, 200, res.body);

    const row = await getFsmRow(id);
    assert.equal(row.status, 'revising');
    assert.equal(row.arbitration_pending_trigger, null);
    assert.equal(row.latest_review_path, 'reviews/arb/');
  });

  it('arbitrating → failed succeeds and clears the pending trigger', async () => {
    const id = await createTask();
    await claim(id);
    await transition(id, { to: 'engineering' });
    await transition(id, {
      to: 'arbitrating',
      payload: {
        trigger: 'reviewer_contradiction',
        contradiction: { findingIds: [1, 2], notes: 'x' },
      },
    });

    const res = await transition(id, {
      to: 'failed',
      payload: {
        failureReason: 'arbitrator_escalated',
        failureDetail: 'arbitrator chose escalate',
      },
    });
    assert.equal(res.statusCode, 200, res.body);

    const row = await getFsmRow(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.arbitration_pending_trigger, null);
    assert.equal(row.failure_reason, 'arbitrator_escalated');
    assert.equal(row.failure_detail, 'arbitrator chose escalate');
  });

  // ── 11. → failed ─────────────────────────────────────────────────────

  it('claimed → failed sets failureReason', async () => {
    const id = await createTask();
    await claim(id);

    const res = await transition(id, {
      to: 'failed',
      payload: { failureReason: 'engineer_build_failure', failureDetail: 'compile error' },
    });
    assert.equal(res.statusCode, 200, res.body);

    const row = await getFsmRow(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.failure_reason, 'engineer_build_failure');
    assert.equal(row.failure_detail, 'compile error');
  });

  it('any → failed returns 400 when failureReason missing', async () => {
    const id = await createTask();
    await claim(id);

    const res = await transition(id, { to: 'failed', payload: {} });
    assert.equal(res.statusCode, 400);
  });

  it('any → failed returns 400 when failureReason is out-of-enum', async () => {
    const id = await createTask();
    await claim(id);

    const res = await transition(id, {
      to: 'failed',
      payload: { failureReason: 'made_up_thing' },
    });
    assert.equal(res.statusCode, 400);
  });

  // ── 12. payload / header validation ───────────────────────────────────

  it('returns 400 when "to" is missing', async () => {
    const id = await createTask();
    await claim(id);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/transition`,
      payload: {},
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 when "to" is unknown', async () => {
    const id = await createTask();
    await claim(id);

    const res = await transition(id, { to: 'wat' });
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 when X-Project-Id header is absent', async () => {
    const id = await createTask();
    await claim(id);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/transition`,
      payload: { to: 'engineering' },
      // No x-project-id header — must be rejected.
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 404 when task not found', async () => {
    const res = await transition(99999, { to: 'engineering' });
    assert.equal(res.statusCode, 404);
  });

  // ── 13. legacy endpoints removed ──────────────────────────────────────

  it('POST /tasks/:id/complete returns 404 (endpoint removed)', async () => {
    const id = await createTask();
    await claim(id);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/complete`,
      payload: { result: { summary: 'x' } },
    });
    assert.equal(res.statusCode, 404);
  });

  it('POST /tasks/:id/fail returns 404 (endpoint removed)', async () => {
    const id = await createTask();
    await claim(id);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/fail`,
      payload: { error: 'boom' },
    });
    assert.equal(res.statusCode, 404);
  });

  // ── 14. surviving reset/integrate endpoints with new enum ────────────

  it('POST /tasks/:id/reset accepts a "complete" task', async () => {
    const id = await createTask();
    await claim(id);
    await transition(id, { to: 'engineering' });
    await transition(id, {
      to: 'built',
      payload: { buildStatus: 'clean', commitSha: 'sha' },
    });
    await transition(id, { to: 'reviewing' });
    await transition(id, {
      to: 'reviewing',
      payload: { reviewerRole: 'safety', verdict: 'approve' },
    });
    await transition(id, { to: 'complete' });

    const res = await ctx.app.inject({ method: 'POST', url: `/tasks/${id}/reset` });
    assert.equal(res.statusCode, 200);

    const task = await getTask(id);
    assert.equal(task.status, 'pending');
  });

  it('POST /tasks/:id/integrate accepts a "complete" task', async () => {
    const id = await createTask();
    await claim(id);
    await transition(id, { to: 'engineering' });
    await transition(id, {
      to: 'built',
      payload: { buildStatus: 'clean', commitSha: 'sha' },
    });
    await transition(id, { to: 'reviewing' });
    await transition(id, {
      to: 'reviewing',
      payload: { reviewerRole: 'safety', verdict: 'approve' },
    });
    await transition(id, { to: 'complete' });

    const res = await ctx.app.inject({ method: 'POST', url: `/tasks/${id}/integrate` });
    assert.equal(res.statusCode, 200);

    const task = await getTask(id);
    assert.equal(task.status, 'integrated');
  });
});
