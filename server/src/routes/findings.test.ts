import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import findingsPlugin from './findings.js';
import { tasks, reviewRuns, reviewFindings, arbitrationRuns } from '../schema/tables.js';

/**
 * Insert a task with arbitrary projectId. Bypasses the public task-creation
 * route so we can plant rows in different projects without wiring full
 * registration boilerplate.
 */
async function insertTask(
  db: DrizzleTestContext['db'],
  opts: { projectId: string; title?: string; status?: string; failureReason?: string | null; completedAt?: Date | null },
): Promise<number> {
  const rows = await db.insert(tasks).values({
    projectId: opts.projectId,
    title: opts.title ?? 'T',
    status: opts.status ?? 'pending',
    failureReason: opts.failureReason ?? null,
    completedAt: opts.completedAt ?? null,
  }).returning();
  return rows[0].id;
}

async function insertRun(
  db: DrizzleTestContext['db'],
  opts: {
    taskId: number;
    cycle: number;
    reviewerRole: string;
    verdict: string;
    rawMarkdown?: string;
    postedAt?: Date;
  },
): Promise<number> {
  const rows = await db.insert(reviewRuns).values({
    taskId: opts.taskId,
    cycle: opts.cycle,
    reviewerRole: opts.reviewerRole,
    verdict: opts.verdict,
    rawMarkdown: opts.rawMarkdown ?? '',
    ...(opts.postedAt ? { postedAt: opts.postedAt } : {}),
  }).returning();
  return rows[0].id;
}

async function insertFinding(
  db: DrizzleTestContext['db'],
  opts: {
    runId: number;
    severity: string;
    title: string;
    ordinal?: number;
    filePath?: string | null;
    line?: number | null;
    description?: string;
  },
): Promise<number> {
  const rows = await db.insert(reviewFindings).values({
    runId: opts.runId,
    severity: opts.severity,
    ordinal: opts.ordinal ?? 0,
    filePath: opts.filePath ?? null,
    line: opts.line ?? null,
    title: opts.title,
    description: opts.description ?? '',
  }).returning();
  return rows[0].id;
}

async function insertArbitration(
  db: DrizzleTestContext['db'],
  opts: {
    taskId: number;
    trigger: 'review_cycle_budget_exhausted' | 'reviewer_contradiction';
    ruling: 'approve' | 'rule' | 'escalate';
    contradictionResolution?: Record<string, unknown> | null;
    postedAt?: Date;
  },
): Promise<number> {
  const rows = await db.insert(arbitrationRuns).values({
    taskId: opts.taskId,
    trigger: opts.trigger,
    ruling: opts.ruling,
    rulingMarkdown: 'r',
    contradictionResolution: opts.ruling === 'rule' ? (opts.contradictionResolution ?? { upheld: 1, retired: 2 }) : null,
    ...(opts.postedAt ? { postedAt: opts.postedAt } : {}),
  }).returning();
  return rows[0].id;
}

describe('findings routes', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(findingsPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  // ── GET /findings ─────────────────────────────────────────────────────

  describe('GET /findings', () => {
    it('rejects missing X-Project-Id with 400', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/findings' });
      assert.equal(res.statusCode, 400, res.body);
    });

    it('returns BLOCKING findings by default, scoped to project', async () => {
      const taskA = await insertTask(ctx.db, { projectId: 'default' });
      const runA = await insertRun(ctx.db, { taskId: taskA, cycle: 1, reviewerRole: 'safety', verdict: 'request_changes' });
      const fA = await insertFinding(ctx.db, { runId: runA, severity: 'BLOCKING', title: 'A blocking' });
      // NOTE-tier should not appear by default
      await insertFinding(ctx.db, { runId: runA, severity: 'NOTE', title: 'A note' });

      // Different project: must NOT appear in 'default' results
      const taskB = await insertTask(ctx.db, { projectId: 'proj-a' });
      const runB = await insertRun(ctx.db, { taskId: taskB, cycle: 1, reviewerRole: 'safety', verdict: 'request_changes' });
      await insertFinding(ctx.db, { runId: runB, severity: 'BLOCKING', title: 'B blocking' });

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/findings',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 200, res.body);
      const json = res.json();
      assert.equal(json.findings.length, 1);
      assert.equal(json.findings[0].id, fA);
      assert.equal(json.findings[0].title, 'A blocking');
      assert.equal(json.total, 1);
    });

    it('filters by severity=NOTE', async () => {
      const t = await insertTask(ctx.db, { projectId: 'default' });
      const run = await insertRun(ctx.db, { taskId: t, cycle: 1, reviewerRole: 'style', verdict: 'approve' });
      await insertFinding(ctx.db, { runId: run, severity: 'BLOCKING', title: 'blk' });
      const fNote = await insertFinding(ctx.db, { runId: run, severity: 'NOTE', title: 'note' });

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/findings?severity=NOTE',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 200);
      const json = res.json();
      assert.equal(json.findings.length, 1);
      assert.equal(json.findings[0].id, fNote);
    });

    it('rejects bad severity', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/findings?severity=WARNING',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('filters by reviewer', async () => {
      const t = await insertTask(ctx.db, { projectId: 'default' });
      const safety = await insertRun(ctx.db, { taskId: t, cycle: 1, reviewerRole: 'safety', verdict: 'request_changes' });
      const correctness = await insertRun(ctx.db, { taskId: t, cycle: 1, reviewerRole: 'correctness', verdict: 'request_changes' });
      await insertFinding(ctx.db, { runId: safety, severity: 'BLOCKING', title: 'safety thing' });
      await insertFinding(ctx.db, { runId: correctness, severity: 'BLOCKING', title: 'correctness thing' });

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/findings?reviewer=safety',
        headers: { 'x-project-id': 'default' },
      });
      const json = res.json();
      assert.equal(json.findings.length, 1);
      assert.equal(json.findings[0].title, 'safety thing');
      assert.equal(json.findings[0].reviewerRole, 'safety');
    });

    it('filters by since (ISO date)', async () => {
      const t = await insertTask(ctx.db, { projectId: 'default' });
      const oldRun = await insertRun(ctx.db, {
        taskId: t, cycle: 1, reviewerRole: 'safety', verdict: 'request_changes',
        postedAt: new Date('2020-01-01T00:00:00Z'),
      });
      const newRun = await insertRun(ctx.db, {
        taskId: t, cycle: 2, reviewerRole: 'safety', verdict: 'request_changes',
        postedAt: new Date(),
      });
      await insertFinding(ctx.db, { runId: oldRun, severity: 'BLOCKING', title: 'old' });
      await insertFinding(ctx.db, { runId: newRun, severity: 'BLOCKING', title: 'new' });

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/findings?since=2024-01-01',
        headers: { 'x-project-id': 'default' },
      });
      const json = res.json();
      assert.equal(json.findings.length, 1);
      assert.equal(json.findings[0].title, 'new');
    });

    it('rejects unparseable since', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/findings?since=not-a-date',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('paginates with limit and offset, sorted by postedAt DESC', async () => {
      const t = await insertTask(ctx.db, { projectId: 'default' });
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) {
        const run = await insertRun(ctx.db, {
          taskId: t, cycle: i, reviewerRole: 'safety', verdict: 'request_changes',
          postedAt: new Date(Date.now() - (5 - i) * 1000),
        });
        const f = await insertFinding(ctx.db, { runId: run, severity: 'BLOCKING', title: `f-${i}` });
        ids.push(f);
      }

      const page1 = await ctx.app.inject({
        method: 'GET',
        url: '/findings?limit=2&offset=0',
        headers: { 'x-project-id': 'default' },
      });
      const j1 = page1.json();
      assert.equal(j1.findings.length, 2);
      assert.equal(j1.total, 5);
      // Most recent first
      assert.equal(j1.findings[0].title, 'f-4');
      assert.equal(j1.findings[1].title, 'f-3');

      const page2 = await ctx.app.inject({
        method: 'GET',
        url: '/findings?limit=2&offset=2',
        headers: { 'x-project-id': 'default' },
      });
      const j2 = page2.json();
      assert.equal(j2.findings.length, 2);
      assert.equal(j2.findings[0].title, 'f-2');
      assert.equal(j2.findings[1].title, 'f-1');
    });

    it('rejects reviewer with disallowed characters', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/findings?reviewer=bad%20role!',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('rejects reviewer exceeding the maximum length', async () => {
      const longReviewer = 'a'.repeat(65);
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/findings?reviewer=${longReviewer}`,
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('rejects limit=0 with 400', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/findings?limit=0',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('rejects negative limit with 400', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/findings?limit=-1',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('rejects non-numeric limit with 400', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/findings?limit=abc',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('does not leak across projects when taskId values collide numerically', async () => {
      // Create a task in proj-a and force a finding into it.
      const tA = await insertTask(ctx.db, { projectId: 'proj-a' });
      const runA = await insertRun(ctx.db, { taskId: tA, cycle: 1, reviewerRole: 'safety', verdict: 'request_changes' });
      await insertFinding(ctx.db, { runId: runA, severity: 'BLOCKING', title: 'A only' });

      // Create another task — id will increment. This proves project filter
      // not just task-id partition.
      const tDef = await insertTask(ctx.db, { projectId: 'default' });
      const runD = await insertRun(ctx.db, { taskId: tDef, cycle: 1, reviewerRole: 'safety', verdict: 'request_changes' });
      await insertFinding(ctx.db, { runId: runD, severity: 'BLOCKING', title: 'default only' });

      const aRes = await ctx.app.inject({
        method: 'GET', url: '/findings',
        headers: { 'x-project-id': 'proj-a' },
      });
      const aJ = aRes.json();
      assert.equal(aJ.findings.length, 1);
      assert.equal(aJ.findings[0].title, 'A only');

      const dRes = await ctx.app.inject({
        method: 'GET', url: '/findings',
        headers: { 'x-project-id': 'default' },
      });
      const dJ = dRes.json();
      assert.equal(dJ.findings.length, 1);
      assert.equal(dJ.findings[0].title, 'default only');
    });
  });

  // ── GET /findings/note-patterns ───────────────────────────────────────

  describe('GET /findings/note-patterns', () => {
    it('rejects missing X-Project-Id with 400', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/findings/note-patterns' });
      assert.equal(res.statusCode, 400);
    });

    it('groups NOTE titles, returns top-N descending, with up to 3 example IDs', async () => {
      const t = await insertTask(ctx.db, { projectId: 'default' });
      const run = await insertRun(ctx.db, { taskId: t, cycle: 1, reviewerRole: 'style', verdict: 'approve' });

      // 'prefer const' x 4
      const ids: number[] = [];
      for (let i = 0; i < 4; i++) {
        const id = await insertFinding(ctx.db, {
          runId: run, severity: 'NOTE', title: 'prefer const', ordinal: i,
        });
        ids.push(id);
      }
      // 'fix import order' x 2
      await insertFinding(ctx.db, { runId: run, severity: 'NOTE', title: 'fix import order', ordinal: 4 });
      await insertFinding(ctx.db, { runId: run, severity: 'NOTE', title: 'fix import order', ordinal: 5 });
      // 'tabs not spaces' x 1
      await insertFinding(ctx.db, { runId: run, severity: 'NOTE', title: 'tabs not spaces', ordinal: 6 });
      // BLOCKING should be excluded
      await insertFinding(ctx.db, { runId: run, severity: 'BLOCKING', title: 'should not appear', ordinal: 7 });

      const res = await ctx.app.inject({
        method: 'GET', url: '/findings/note-patterns',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 200, res.body);
      const json = res.json();

      assert.equal(json.patterns.length, 3);
      assert.equal(json.patterns[0].title, 'prefer const');
      assert.equal(json.patterns[0].count, 4);
      assert.equal(json.patterns[0].exampleFindingIds.length, 3);
      // The blocking title must not be in any group
      for (const p of json.patterns) {
        assert.notEqual(p.title, 'should not appear');
      }
      assert.equal(json.patterns[1].title, 'fix import order');
      assert.equal(json.patterns[1].count, 2);
      assert.equal(json.patterns[1].exampleFindingIds.length, 2);
      assert.equal(json.patterns[2].title, 'tabs not spaces');
      assert.equal(json.patterns[2].count, 1);
      assert.equal(json.patterns[2].exampleFindingIds.length, 1);
    });

    it('respects limit', async () => {
      const t = await insertTask(ctx.db, { projectId: 'default' });
      const run = await insertRun(ctx.db, { taskId: t, cycle: 1, reviewerRole: 'style', verdict: 'approve' });
      for (let i = 0; i < 5; i++) {
        await insertFinding(ctx.db, { runId: run, severity: 'NOTE', title: `t-${i}`, ordinal: i });
      }

      const res = await ctx.app.inject({
        method: 'GET', url: '/findings/note-patterns?limit=2',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.json().patterns.length, 2);
    });

    it('rejects limit=0 with 400', async () => {
      const res = await ctx.app.inject({
        method: 'GET', url: '/findings/note-patterns?limit=0',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('rejects negative limit with 400', async () => {
      const res = await ctx.app.inject({
        method: 'GET', url: '/findings/note-patterns?limit=-1',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('does not leak across projects', async () => {
      const tA = await insertTask(ctx.db, { projectId: 'proj-a' });
      const runA = await insertRun(ctx.db, { taskId: tA, cycle: 1, reviewerRole: 'style', verdict: 'approve' });
      await insertFinding(ctx.db, { runId: runA, severity: 'NOTE', title: 'a-pattern', ordinal: 0 });

      const tD = await insertTask(ctx.db, { projectId: 'default' });
      const runD = await insertRun(ctx.db, { taskId: tD, cycle: 1, reviewerRole: 'style', verdict: 'approve' });
      await insertFinding(ctx.db, { runId: runD, severity: 'NOTE', title: 'd-pattern', ordinal: 0 });

      const aRes = await ctx.app.inject({
        method: 'GET', url: '/findings/note-patterns',
        headers: { 'x-project-id': 'proj-a' },
      });
      const aPatterns = aRes.json().patterns;
      assert.equal(aPatterns.length, 1);
      assert.equal(aPatterns[0].title, 'a-pattern');
    });
  });

  // ── GET /arbitrations ─────────────────────────────────────────────────

  describe('GET /arbitrations', () => {
    it('rejects missing X-Project-Id with 400', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/arbitrations' });
      assert.equal(res.statusCode, 400);
    });

    it('groups by (trigger, ruling) and returns example task ids', async () => {
      // Create 3 tasks and arbitrations: 2x (cycle_budget, approve), 1x (contradiction, rule)
      const t1 = await insertTask(ctx.db, { projectId: 'default' });
      const t2 = await insertTask(ctx.db, { projectId: 'default' });
      const t3 = await insertTask(ctx.db, { projectId: 'default' });

      await insertArbitration(ctx.db, {
        taskId: t1, trigger: 'review_cycle_budget_exhausted', ruling: 'approve',
      });
      await insertArbitration(ctx.db, {
        taskId: t2, trigger: 'review_cycle_budget_exhausted', ruling: 'approve',
      });
      await insertArbitration(ctx.db, {
        taskId: t3, trigger: 'reviewer_contradiction', ruling: 'rule',
      });

      const res = await ctx.app.inject({
        method: 'GET', url: '/arbitrations',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 200, res.body);
      const json = res.json();
      assert.equal(json.patterns.length, 2);

      // First by count desc
      assert.equal(json.patterns[0].count, 2);
      assert.equal(json.patterns[0].trigger, 'review_cycle_budget_exhausted');
      assert.equal(json.patterns[0].ruling, 'approve');
      assert.equal(json.patterns[0].exampleTaskIds.length, 2);
      assert.ok(json.patterns[0].exampleTaskIds.includes(t1));
      assert.ok(json.patterns[0].exampleTaskIds.includes(t2));

      assert.equal(json.patterns[1].count, 1);
      assert.equal(json.patterns[1].trigger, 'reviewer_contradiction');
      assert.equal(json.patterns[1].ruling, 'rule');
      assert.deepEqual(json.patterns[1].exampleTaskIds, [t3]);
    });

    it('caps example task IDs at 3', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = await insertTask(ctx.db, { projectId: 'default' });
        ids.push(t);
        await insertArbitration(ctx.db, {
          taskId: t,
          trigger: 'review_cycle_budget_exhausted',
          ruling: 'escalate',
          postedAt: new Date(Date.now() - (5 - i) * 1000),
        });
      }

      const res = await ctx.app.inject({
        method: 'GET', url: '/arbitrations',
        headers: { 'x-project-id': 'default' },
      });
      const j = res.json();
      assert.equal(j.patterns.length, 1);
      assert.equal(j.patterns[0].count, 5);
      assert.equal(j.patterns[0].exampleTaskIds.length, 3);
    });

    it('does not leak across projects', async () => {
      const tA = await insertTask(ctx.db, { projectId: 'proj-a' });
      await insertArbitration(ctx.db, {
        taskId: tA, trigger: 'review_cycle_budget_exhausted', ruling: 'approve',
      });
      const tD = await insertTask(ctx.db, { projectId: 'default' });
      await insertArbitration(ctx.db, {
        taskId: tD, trigger: 'reviewer_contradiction', ruling: 'rule',
      });

      const aRes = await ctx.app.inject({
        method: 'GET', url: '/arbitrations',
        headers: { 'x-project-id': 'proj-a' },
      });
      const aJ = aRes.json();
      assert.equal(aJ.patterns.length, 1);
      assert.equal(aJ.patterns[0].trigger, 'review_cycle_budget_exhausted');
    });

    it('respects since (excludes older arbitrations)', async () => {
      const t = await insertTask(ctx.db, { projectId: 'default' });
      await insertArbitration(ctx.db, {
        taskId: t,
        trigger: 'review_cycle_budget_exhausted',
        ruling: 'approve',
        postedAt: new Date('2020-01-01T00:00:00Z'),
      });

      const res = await ctx.app.inject({
        method: 'GET', url: '/arbitrations?since=2024-01-01',
        headers: { 'x-project-id': 'default' },
      });
      const j = res.json();
      assert.equal(j.patterns.length, 0);
    });
  });

});
