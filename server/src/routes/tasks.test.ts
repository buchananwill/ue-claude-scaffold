import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, createTestConfig, type TestContext } from '../test-helper.js';
import tasksPlugin from './tasks.js';

describe('tasks routes', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
    const config = createTestConfig();
    await ctx.app.register(tasksPlugin, { config });
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

  it('POST /tasks/:id/release returns claimed task to pending', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Releasable' },
    });
    const id = post.json().id;

    // Claim it
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });

    // Release it
    const release = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/release`,
    });
    assert.equal(release.statusCode, 200);
    assert.deepEqual(release.json(), { ok: true });

    // Verify it's pending again
    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.equal(task.status, 'pending');
    assert.equal(task.claimedBy, null);
    assert.equal(task.claimedAt, null);
  });

  it('POST /tasks/:id/release returns 409 for pending task', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Already pending' },
    });
    const id = post.json().id;

    const release = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/release`,
    });
    assert.equal(release.statusCode, 409);
  });

  // ── PATCH /tasks/:id ─────────────────────────────────────────────────

  it('PATCH /tasks/:id updates title of a pending task', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Original title' },
    });
    const id = post.json().id;

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { title: 'Updated title' },
    });
    assert.equal(patch.statusCode, 200);
    assert.deepEqual(patch.json(), { ok: true });

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.equal(task.title, 'Updated title');
  });

  it('PATCH /tasks/:id partial update only touches provided fields', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Keep me', description: 'Original desc', priority: 3 },
    });
    const id = post.json().id;

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { priority: 10 },
    });
    assert.equal(patch.statusCode, 200);

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.equal(task.title, 'Keep me');
    assert.equal(task.description, 'Original desc');
    assert.equal(task.priority, 10);
  });

  it('PATCH /tasks/:id returns 404 for missing task', async () => {
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: '/tasks/99999',
      payload: { title: 'Nope' },
    });
    assert.equal(patch.statusCode, 404);
  });

  it('PATCH /tasks/:id returns 409 when task is claimed', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Will be claimed' },
    });
    const id = post.json().id;

    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { title: 'Too late' },
    });
    assert.equal(patch.statusCode, 409);
  });

  it('PATCH /tasks/:id returns 409 when task is completed', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Will be completed' },
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

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { title: 'Too late' },
    });
    assert.equal(patch.statusCode, 409);
  });

  it('PATCH /tasks/:id returns 400 when body has no updatable fields', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Untouched' },
    });
    const id = post.json().id;

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { bogus: 'field' },
    });
    assert.equal(patch.statusCode, 400);
  });

  it('PATCH /tasks/:id allows clearing sourcePath to null', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Has no source' },
    });
    const id = post.json().id;

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { sourcePath: null },
    });
    assert.equal(patch.statusCode, 200);
    assert.deepEqual(patch.json(), { ok: true });

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    assert.equal(get.json().sourcePath, null);
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
});
