import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestContext } from '../test-helper.js';
import tasksPlugin from './tasks.js';

describe('tasks routes', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
    await ctx.app.register(tasksPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.cleanup();
  });

  it('POST /tasks creates a task and returns id', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Build widget', description: 'Create the widget system' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.id, 'number');
  });

  it('GET /tasks returns all tasks', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Task A' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Task B' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks' });
    assert.equal(res.statusCode, 200);
    const tasks = res.json();
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].title, 'Task A');
    assert.equal(tasks[1].title, 'Task B');
  });

  it('GET /tasks?status=pending filters by status', async () => {
    // Create two tasks, claim one so its status changes
    const r1 = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Pending task' },
    });
    const r2 = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Claimed task' },
    });
    const claimedId = r2.json().id;

    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${claimedId}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?status=pending' });
    assert.equal(res.statusCode, 200);
    const tasks = res.json();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, 'Pending task');
    assert.equal(tasks[0].status, 'pending');
  });

  it('GET /tasks/:id returns a single task', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'My task', description: 'Details here', priority: 5 },
    });
    const id = post.json().id;

    const res = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    assert.equal(res.statusCode, 200);
    const task = res.json();
    assert.equal(task.id, id);
    assert.equal(task.title, 'My task');
    assert.equal(task.description, 'Details here');
    assert.equal(task.priority, 5);
    assert.equal(task.status, 'pending');
    assert.equal(task.claimedBy, null);
    assert.ok(task.createdAt);
  });

  it('GET /tasks/:id returns 404 for missing task', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/tasks/99999' });
    assert.equal(res.statusCode, 404);
  });

  it('POST /tasks/:id/claim succeeds for pending task', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Claimable' },
    });
    const id = post.json().id;

    const claim = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });
    assert.equal(claim.statusCode, 200);
    assert.deepEqual(claim.json(), { ok: true });

    // Verify the task is now claimed
    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.equal(task.status, 'claimed');
    assert.equal(task.claimedBy, 'agent-1');
    assert.ok(task.claimedAt);
  });

  it('POST /tasks/:id/claim returns 409 for already-claimed task', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Already claimed' },
    });
    const id = post.json().id;

    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });

    const claim2 = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-agent-name': 'agent-2' },
    });
    assert.equal(claim2.statusCode, 409);
  });

  it('POST /tasks/:id/update appends to progress_log', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Updatable' },
    });
    const id = post.json().id;

    // Claim first so it is in a valid state for update
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });

    const update = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/update`,
      payload: { progress: 'Step 1 done' },
    });
    assert.equal(update.statusCode, 200);
    assert.deepEqual(update.json(), { ok: true });

    // Verify progress log contains the update text
    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.equal(task.status, 'in_progress');
    assert.ok(task.progressLog.includes('Step 1 done'));
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
});
