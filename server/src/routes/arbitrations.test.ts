import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { createTestConfig, registerAgent } from '../test-helper.js';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import tasksPlugin from './tasks.js';
import agentsPlugin from './agents.js';
import arbitrationsPlugin from './arbitrations.js';

describe('arbitrations routes', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    const config = createTestConfig();
    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(tasksPlugin, { config });
    await ctx.app.register(arbitrationsPlugin);
    await registerAgent(ctx.app, 'agent-1');
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  // ── Test helpers ────────────────────────────────────────────────────

  /** Create a task and return its id. */
  async function createTask(title = 'arb-task'): Promise<number> {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title },
    });
    return post.json().id as number;
  }

  /**
   * Force a task into `arbitrating` with the given trigger. Sidesteps the FSM
   * transition endpoint — this test file is scoped to /arbitrations, so we
   * seed the precondition state directly.
   */
  async function forceArbitrating(
    id: number,
    trigger: 'review_cycle_budget_exhausted' | 'reviewer_contradiction',
  ): Promise<void> {
    await ctx.db.execute(sql`
      UPDATE tasks
         SET status = 'arbitrating',
             arbitration_pending_trigger = ${trigger}
       WHERE id = ${id}
    `);
  }

  function postArbitration(
    taskId: number,
    body: Record<string, unknown>,
    headers: Record<string, string> = { 'x-project-id': 'default' },
  ) {
    return ctx.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/arbitrations`,
      payload: body,
      headers,
    });
  }

  type TaskRowShape = {
    status: string;
    arbitration_pending_trigger: string | null;
    arbitration_addendum_path: string | null;
    failure_reason: string | null;
    failure_detail: string | null;
    completed_at: string | null;
  };

  async function getTaskRow(id: number): Promise<TaskRowShape> {
    const result = await ctx.db.execute(sql`
      SELECT status,
             arbitration_pending_trigger,
             arbitration_addendum_path,
             failure_reason,
             failure_detail,
             completed_at
        FROM tasks
       WHERE id = ${id}
    `);
    const rows = (result as unknown as { rows: TaskRowShape[] }).rows;
    return rows[0];
  }

  type ArbRunRowShape = {
    id: number;
    task_id: number;
    trigger: string;
    ruling: string;
    ruling_markdown: string;
    contradiction_resolution: Record<string, unknown> | null;
  };

  async function getArbRuns(taskId: number): Promise<ArbRunRowShape[]> {
    const result = await ctx.db.execute(sql`
      SELECT id, task_id, trigger, ruling, ruling_markdown, contradiction_resolution
        FROM arbitration_runs
       WHERE task_id = ${taskId}
       ORDER BY id ASC
    `);
    return (result as unknown as { rows: ArbRunRowShape[] }).rows;
  }

  // ── 1. Happy paths ───────────────────────────────────────────────────

  it('approve ruling transitions task to complete and clears pending trigger', async () => {
    const id = await createTask();
    await forceArbitrating(id, 'review_cycle_budget_exhausted');

    const res = await postArbitration(id, {
      trigger: 'review_cycle_budget_exhausted',
      ruling: 'approve',
      rulingMarkdown: 'Reviewers nitpicked stylistic noise; substance is correct. Approving.',
    });

    assert.equal(res.statusCode, 200, res.body);
    const json = res.json();
    assert.equal(typeof json.runId, 'number');
    assert.equal(json.newStatus, 'complete');

    const row = await getTaskRow(id);
    assert.equal(row.status, 'complete');
    assert.equal(row.arbitration_pending_trigger, null);
    assert.notEqual(row.completed_at, null);

    const runs = await getArbRuns(id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].trigger, 'review_cycle_budget_exhausted');
    assert.equal(runs[0].ruling, 'approve');
    assert.equal(runs[0].contradiction_resolution, null);
  });

  it('rule ruling on reviewer_contradiction transitions to revising and sets addendum path', async () => {
    const id = await createTask();
    await forceArbitrating(id, 'reviewer_contradiction');

    const res = await postArbitration(id, {
      trigger: 'reviewer_contradiction',
      ruling: 'rule',
      rulingMarkdown: 'Safety mandate wins; decomp finding retired this cycle.',
      contradictionResolution: {
        upheldFindingId: 11,
        retiredFindingId: 22,
        rationale: 'Safety boundary is a hard rule; decomposition is advisory.',
      },
    });

    assert.equal(res.statusCode, 200, res.body);
    const json = res.json();
    assert.equal(typeof json.runId, 'number');
    assert.equal(json.newStatus, 'revising');

    const row = await getTaskRow(id);
    assert.equal(row.status, 'revising');
    assert.equal(row.arbitration_pending_trigger, null);
    assert.equal(
      row.arbitration_addendum_path,
      `.scratch/arbitrations/${id}/contradiction-ruling.md`,
    );

    const runs = await getArbRuns(id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].ruling, 'rule');
    assert.deepEqual(runs[0].contradiction_resolution, {
      upheldFindingId: 11,
      retiredFindingId: 22,
      rationale: 'Safety boundary is a hard rule; decomposition is advisory.',
    });
  });

  it('escalate ruling transitions to failed with arbitrator_escalated reason', async () => {
    const id = await createTask();
    await forceArbitrating(id, 'review_cycle_budget_exhausted');

    const longMarkdown = 'a'.repeat(750);
    const res = await postArbitration(id, {
      trigger: 'review_cycle_budget_exhausted',
      ruling: 'escalate',
      rulingMarkdown: longMarkdown,
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().newStatus, 'failed');

    const row = await getTaskRow(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.arbitration_pending_trigger, null);
    assert.equal(row.failure_reason, 'arbitrator_escalated');
    // Truncated to first 500 chars per plan step 1.
    assert.equal(row.failure_detail, 'a'.repeat(500));
    assert.notEqual(row.completed_at, null);
  });

  it('escalate ruling on reviewer_contradiction is also valid', async () => {
    const id = await createTask();
    await forceArbitrating(id, 'reviewer_contradiction');

    const res = await postArbitration(id, {
      trigger: 'reviewer_contradiction',
      ruling: 'escalate',
      rulingMarkdown: 'Both reviewers raise valid concerns; need operator review.',
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().newStatus, 'failed');

    const row = await getTaskRow(id);
    assert.equal(row.failure_reason, 'arbitrator_escalated');
  });

  // ── 2. Cross-field validation (trigger × ruling × contradictionResolution) ──

  it('rejects rule on cycle-exhausted trigger with 400', async () => {
    const id = await createTask();
    await forceArbitrating(id, 'review_cycle_budget_exhausted');

    const res = await postArbitration(id, {
      trigger: 'review_cycle_budget_exhausted',
      ruling: 'rule',
      rulingMarkdown: 'should not be allowed',
      contradictionResolution: {
        upheldFindingId: 1,
        retiredFindingId: 2,
        rationale: 'x',
      },
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.body, /reviewer_contradiction/);

    // No arbitrationRuns row, task remains in arbitrating.
    const runs = await getArbRuns(id);
    assert.equal(runs.length, 0);
    const row = await getTaskRow(id);
    assert.equal(row.status, 'arbitrating');
  });

  it('rejects rule without contradictionResolution with 400', async () => {
    const id = await createTask();
    await forceArbitrating(id, 'reviewer_contradiction');

    const res = await postArbitration(id, {
      trigger: 'reviewer_contradiction',
      ruling: 'rule',
      rulingMarkdown: 'forgot the resolution',
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.body, /contradictionResolution is required/);
  });

  it('rejects non-rule ruling that carries contradictionResolution with 400', async () => {
    const id = await createTask();
    await forceArbitrating(id, 'reviewer_contradiction');

    const res = await postArbitration(id, {
      trigger: 'reviewer_contradiction',
      ruling: 'approve',
      rulingMarkdown: 'ok',
      contradictionResolution: {
        upheldFindingId: 1,
        retiredFindingId: 2,
        rationale: 'x',
      },
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.body, /must be absent/);
  });

  it('rejects contradictionResolution with equal upheld and retired ids', async () => {
    const id = await createTask();
    await forceArbitrating(id, 'reviewer_contradiction');

    const res = await postArbitration(id, {
      trigger: 'reviewer_contradiction',
      ruling: 'rule',
      rulingMarkdown: 'bad resolution',
      contradictionResolution: {
        upheldFindingId: 7,
        retiredFindingId: 7,
        rationale: 'same id',
      },
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.body, /must differ/);
  });

  it('rejects contradictionResolution with non-positive upheld id', async () => {
    const id = await createTask();
    await forceArbitrating(id, 'reviewer_contradiction');

    const res = await postArbitration(id, {
      trigger: 'reviewer_contradiction',
      ruling: 'rule',
      rulingMarkdown: 'bad',
      contradictionResolution: {
        upheldFindingId: 0,
        retiredFindingId: 2,
        rationale: 'x',
      },
    });

    assert.equal(res.statusCode, 400);
  });

  it('rejects contradictionResolution with empty rationale', async () => {
    const id = await createTask();
    await forceArbitrating(id, 'reviewer_contradiction');

    const res = await postArbitration(id, {
      trigger: 'reviewer_contradiction',
      ruling: 'rule',
      rulingMarkdown: 'bad',
      contradictionResolution: {
        upheldFindingId: 1,
        retiredFindingId: 2,
        rationale: '',
      },
    });

    assert.equal(res.statusCode, 400);
  });

  // ── 3. Body-shape validation ─────────────────────────────────────────

  it('rejects missing trigger', async () => {
    const id = await createTask();
    await forceArbitrating(id, 'reviewer_contradiction');
    const res = await postArbitration(id, {
      ruling: 'approve',
      rulingMarkdown: 'x',
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects bad trigger value', async () => {
    const id = await createTask();
    await forceArbitrating(id, 'reviewer_contradiction');
    const res = await postArbitration(id, {
      trigger: 'made_up',
      ruling: 'approve',
      rulingMarkdown: 'x',
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects bad ruling value', async () => {
    const id = await createTask();
    await forceArbitrating(id, 'reviewer_contradiction');
    const res = await postArbitration(id, {
      trigger: 'reviewer_contradiction',
      ruling: 'maybe',
      rulingMarkdown: 'x',
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects empty rulingMarkdown', async () => {
    const id = await createTask();
    await forceArbitrating(id, 'reviewer_contradiction');
    const res = await postArbitration(id, {
      trigger: 'reviewer_contradiction',
      ruling: 'approve',
      rulingMarkdown: '',
    });
    assert.equal(res.statusCode, 400);
  });

  // ── 4. Uniqueness on (taskId, trigger) ───────────────────────────────

  it('second arbitration for same (taskId, trigger) returns 409', async () => {
    const id = await createTask();
    await forceArbitrating(id, 'reviewer_contradiction');

    const first = await postArbitration(id, {
      trigger: 'reviewer_contradiction',
      ruling: 'rule',
      rulingMarkdown: 'first ruling',
      contradictionResolution: {
        upheldFindingId: 1,
        retiredFindingId: 2,
        rationale: 'first',
      },
    });
    assert.equal(first.statusCode, 200, first.body);

    // The task is now `revising`. Force it back to `arbitrating` to retry the
    // POST — the uniqueness check on (taskId, trigger) must still fire.
    await forceArbitrating(id, 'reviewer_contradiction');

    const second = await postArbitration(id, {
      trigger: 'reviewer_contradiction',
      ruling: 'approve',
      rulingMarkdown: 'second ruling',
    });
    assert.equal(second.statusCode, 409, second.body);

    // Exactly one arbitrationRuns row remains.
    const runs = await getArbRuns(id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].ruling, 'rule');
  });

  // ── 5. Atomicity: failed transition rolls back the insert ────────────

  it('rejects with 409 when task is not in arbitrating', async () => {
    const id = await createTask();
    // Leave task in 'pending' — POST should 409 the pre-flight, no row inserted.

    const res = await postArbitration(id, {
      trigger: 'reviewer_contradiction',
      ruling: 'approve',
      rulingMarkdown: 'x',
    });

    assert.equal(res.statusCode, 409, res.body);
    const runs = await getArbRuns(id);
    assert.equal(runs.length, 0);
  });

  it('returns 404 for unknown task id', async () => {
    const res = await postArbitration(999_999, {
      trigger: 'reviewer_contradiction',
      ruling: 'approve',
      rulingMarkdown: 'x',
    });
    assert.equal(res.statusCode, 404);
  });

  it('rejects invalid (zero) task id with 400', async () => {
    const res = await postArbitration(0, {
      trigger: 'reviewer_contradiction',
      ruling: 'approve',
      rulingMarkdown: 'x',
    });
    assert.equal(res.statusCode, 400);
  });

  // ── 6. X-Project-Id header guard ─────────────────────────────────────

  it('requires X-Project-Id header (400 when missing)', async () => {
    const id = await createTask();
    await forceArbitrating(id, 'reviewer_contradiction');

    const res = await postArbitration(
      id,
      {
        trigger: 'reviewer_contradiction',
        ruling: 'approve',
        rulingMarkdown: 'x',
      },
      // No x-project-id header.
      {},
    );

    assert.equal(res.statusCode, 400);
    assert.match(res.body, /X-Project-Id/);
  });

  it('returns 404 for task in a different project', async () => {
    const id = await createTask();
    await forceArbitrating(id, 'reviewer_contradiction');

    const res = await postArbitration(
      id,
      {
        trigger: 'reviewer_contradiction',
        ruling: 'approve',
        rulingMarkdown: 'x',
      },
      { 'x-project-id': 'some-other-project' },
    );

    assert.equal(res.statusCode, 404);
  });
});
