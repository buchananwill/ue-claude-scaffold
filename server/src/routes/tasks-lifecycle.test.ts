import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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

  it('POST /tasks/:id/complete marks task completed with result', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Completable' },
    });
    const id = post.json().id;

    // Claim first
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });

    const complete = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/complete`,
      payload: { result: { summary: 'All done', filesChanged: 3 } },
    });
    assert.equal(complete.statusCode, 200);
    assert.deepEqual(complete.json(), { ok: true });

    // Verify completion
    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.equal(task.status, 'completed');
    assert.ok(task.completedAt);
    assert.deepEqual(task.result, { summary: 'All done', filesChanged: 3 });
  });

  it('POST /tasks/:id/fail marks task failed with error', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Failable' },
    });
    const id = post.json().id;

    // Claim first
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });

    const fail = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/fail`,
      payload: { error: 'Compilation failed' },
    });
    assert.equal(fail.statusCode, 200);
    assert.deepEqual(fail.json(), { ok: true });

    // Verify failure
    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.equal(task.status, 'failed');
    assert.ok(task.completedAt);
    assert.deepEqual(task.result, { error: 'Compilation failed' });
  });

  // ── POST /tasks/:id/reset ────────────────────────────────────────────

  it('POST /tasks/:id/reset resets a completed task to pending', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Completed then reset' },
    });
    const id = post.json().id;

    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/update`,
      payload: { progress: 'Some progress' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/complete`,
      payload: { result: { summary: 'Finished' } },
    });

    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/reset`,
    });
    assert.equal(reset.statusCode, 200);
    assert.deepEqual(reset.json(), { ok: true });

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.equal(task.status, 'pending');
    assert.equal(task.claimedBy, null);
    assert.equal(task.claimedAt, null);
    assert.equal(task.completedAt, null);
    assert.equal(task.result, null);
    assert.equal(task.progressLog, null);
  });

  it('POST /tasks/:id/reset resets a failed task to pending', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Failed then reset' },
    });
    const id = post.json().id;

    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/fail`,
      payload: { error: 'Build broke' },
    });

    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/reset`,
    });
    assert.equal(reset.statusCode, 200);
    assert.deepEqual(reset.json(), { ok: true });

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.equal(task.status, 'pending');
    assert.equal(task.claimedBy, null);
    assert.equal(task.claimedAt, null);
    assert.equal(task.completedAt, null);
    assert.equal(task.result, null);
    assert.equal(task.progressLog, null);
  });

  it('POST /tasks/:id/reset returns 404 for missing task', async () => {
    const reset = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/99999/reset',
    });
    assert.equal(reset.statusCode, 404);
  });

  it('POST /tasks/:id/reset returns 409 when task is pending', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Never claimed' },
    });
    const id = post.json().id;

    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/reset`,
    });
    assert.equal(reset.statusCode, 409);
  });

  it('POST /tasks/:id/reset returns 409 when task is claimed', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Currently claimed' },
    });
    const id = post.json().id;

    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });

    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/reset`,
    });
    assert.equal(reset.statusCode, 409);
  });

  it('POST /tasks/:id/reset returns ok:true confirming TOCTOU guard did not false-positive', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'TOCTOU check' },
    });
    const id = post.json().id;

    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/complete`,
      payload: { result: { summary: 'Done' } },
    });

    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/reset`,
    });
    assert.equal(reset.statusCode, 200);
    assert.deepEqual(reset.json(), { ok: true });
  });

  // ── Phase 2: integrate endpoints ──────────────────────────────────────

  /** Helper: create a task, claim it with the given agent, complete it, return the id. */
  async function createCompletedTaskWithAgent(app: typeof ctx.app, agent: string) {
    const post = await app.inject({ method: 'POST', url: '/tasks', payload: { title: `Task by ${agent}` } });
    const id = post.json().id;
    await app.inject({ method: 'POST', url: `/tasks/${id}/claim`, headers: { 'x-agent-name': agent } });
    await app.inject({ method: 'POST', url: `/tasks/${id}/complete`, payload: { result: { summary: 'done', agent } } });
    return id;
  }

  describe('POST /tasks/:id/integrate', () => {
    /** Helper: create a task, claim it, complete it, return the id */
    async function createCompletedTask(app: typeof ctx.app, result: Record<string, unknown> = { summary: 'done', agent: 'agent-1' }) {
      const post = await app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Integrate me' } });
      const id = post.json().id;
      await app.inject({ method: 'POST', url: `/tasks/${id}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await app.inject({ method: 'POST', url: `/tasks/${id}/complete`, payload: { result } });
      return id;
    }

    it('on a completed task returns 200 and status is integrated', async () => {
      const id = await createCompletedTask(ctx.app);

      const res = await ctx.app.inject({ method: 'POST', url: `/tasks/${id}/integrate` });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { ok: true });

      const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
      assert.equal(get.json().status, 'integrated');
    });

    it('on a pending task returns 400', async () => {
      const post = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Still pending' } });
      const id = post.json().id;

      const res = await ctx.app.inject({ method: 'POST', url: `/tasks/${id}/integrate` });
      assert.equal(res.statusCode, 400);
    });

    it('on a claimed task returns 400', async () => {
      const post = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Claimed only' } });
      const id = post.json().id;
      await ctx.app.inject({ method: 'POST', url: `/tasks/${id}/claim`, headers: { 'x-agent-name': 'agent-1' } });

      const res = await ctx.app.inject({ method: 'POST', url: `/tasks/${id}/integrate` });
      assert.equal(res.statusCode, 400);
    });

    it('returns 404 for missing task', async () => {
      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/99999/integrate' });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('POST /tasks/integrate-batch', () => {
    it('integrates only the specified agent completed tasks', async () => {
      const id1 = await createCompletedTaskWithAgent(ctx.app, 'agent-1');
      const id2 = await createCompletedTaskWithAgent(ctx.app, 'agent-1');
      const id3 = await createCompletedTaskWithAgent(ctx.app, 'agent-2');

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/integrate-batch', payload: { agent: 'agent-1' } });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.ok, true);
      assert.equal(body.count, 2);
      assert.deepEqual(body.ids.sort(), [id1, id2].sort());

      // agent-2's task should still be completed
      const get3 = await ctx.app.inject({ method: 'GET', url: `/tasks/${id3}` });
      assert.equal(get3.json().status, 'completed');
    });

    it('with no matching tasks returns count 0', async () => {
      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/integrate-batch', payload: { agent: 'nobody' } });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.ok, true);
      assert.equal(body.count, 0);
      assert.deepEqual(body.ids, []);
    });

    it('returns 400 when agent is missing', async () => {
      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/integrate-batch', payload: {} });
      assert.equal(res.statusCode, 400);
    });
  });

  describe('POST /tasks/integrate-all', () => {
    it('integrates all completed tasks regardless of agent', async () => {
      const id1 = await createCompletedTaskWithAgent(ctx.app, 'agent-1');
      const id2 = await createCompletedTaskWithAgent(ctx.app, 'agent-2');
      // Also create a pending task that should NOT be integrated
      await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Still pending' } });

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/integrate-all' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.ok, true);
      assert.equal(body.count, 2);
      assert.deepEqual(body.ids.sort(), [id1, id2].sort());
    });

    it('when no completed tasks returns count 0', async () => {
      // Only create a pending task
      await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Pending' } });

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/integrate-all' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.ok, true);
      assert.equal(body.count, 0);
      assert.deepEqual(body.ids, []);
    });
  });

  describe('GET /tasks with integrated status', () => {
    it('returns tasks with integrated status', async () => {
      const post = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Will integrate' } });
      const id = post.json().id;
      await ctx.app.inject({ method: 'POST', url: `/tasks/${id}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${id}/complete`, payload: { result: { summary: 'done' } } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${id}/integrate` });

      const res = await ctx.app.inject({ method: 'GET', url: '/tasks?status=integrated' });
      assert.equal(res.statusCode, 200);
      const body = res.json<{ tasks: Array<Record<string, unknown>>; total: number }>();
      const tasks = body.tasks;
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].status, 'integrated');
      assert.equal(tasks[0].id, id);
    });
  });

  describe('formatTask completedBy field', () => {
    it('includes completedBy extracted from result.agent', async () => {
      const post = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Has agent' } });
      const id = post.json().id;
      await ctx.app.inject({ method: 'POST', url: `/tasks/${id}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${id}/complete`, payload: { result: { summary: 'done', agent: 'agent-1' } } });

      const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
      const task = get.json();
      assert.equal(task.completedBy, 'agent-1');
    });

    it('completedBy is null when result has no agent field', async () => {
      const post = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'No agent field' } });
      const id = post.json().id;
      await ctx.app.inject({ method: 'POST', url: `/tasks/${id}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${id}/complete`, payload: { result: { summary: 'done' } } });

      const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
      const task = get.json();
      assert.equal(task.completedBy, null);
    });
  });
});
