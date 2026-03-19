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

  // ── File dependencies (Phase 1) ──────────────────────────────────────

  it('POST /tasks with files array creates task_files rows and registers files', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        title: 'With files',
        files: ['Source/Foo.cpp', 'Source/Foo.h'],
      },
    });
    assert.equal(res.statusCode, 200);
    const { id } = res.json();

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.deepEqual(task.files, ['Source/Foo.cpp', 'Source/Foo.h']);
  });

  it('POST /tasks without files returns files as empty array', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'No files' },
    });
    const { id } = res.json();

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    assert.deepEqual(get.json().files, []);
  });

  it('POST /tasks with invalid file path returns 400', async () => {
    const cases = [
      { files: ['../etc/passwd'], label: '..' },
      { files: ['/absolute/path'], label: 'absolute' },
      { files: [''], label: 'empty' },
    ];
    for (const { files, label } of cases) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: `Bad path (${label})`, files },
      });
      assert.equal(res.statusCode, 400, `Expected 400 for ${label} path`);
    }
  });

  it('GET /tasks/:id returns files array', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Files test', files: ['A.cpp', 'B.h'] },
    });
    const { id } = post.json();

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.equal(Array.isArray(task.files), true);
    assert.equal(task.files.length, 2);
    assert.ok(task.files.includes('A.cpp'));
    assert.ok(task.files.includes('B.h'));
  });

  it('PATCH /tasks/:id can update files on pending task', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Patch files', files: ['Old.cpp'] },
    });
    const { id } = post.json();

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { files: ['New.cpp', 'New.h'] },
    });
    assert.equal(patch.statusCode, 200);

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.deepEqual(task.files.sort(), ['New.cpp', 'New.h']);
  });

  it('DELETE /tasks/:id cascades to task_files', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Delete me', files: ['Doomed.cpp'] },
    });
    const { id } = post.json();

    const del = await ctx.app.inject({ method: 'DELETE', url: `/tasks/${id}` });
    assert.equal(del.statusCode, 200);

    // Task gone
    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    assert.equal(get.statusCode, 404);
  });

  it('POST /tasks/batch creates all tasks atomically with file registrations', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/batch',
      payload: {
        tasks: [
          { title: 'Batch 1', files: ['Shared.cpp'] },
          { title: 'Batch 2', priority: 5, files: ['Shared.cpp', 'Only2.h'] },
          { title: 'Batch 3' },
        ],
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.ids.length, 3);

    // Verify files on each task
    const get1 = await ctx.app.inject({ method: 'GET', url: `/tasks/${body.ids[0]}` });
    assert.deepEqual(get1.json().files, ['Shared.cpp']);

    const get2 = await ctx.app.inject({ method: 'GET', url: `/tasks/${body.ids[1]}` });
    assert.deepEqual(get2.json().files.sort(), ['Only2.h', 'Shared.cpp']);

    const get3 = await ctx.app.inject({ method: 'GET', url: `/tasks/${body.ids[2]}` });
    assert.deepEqual(get3.json().files, []);
  });

  it('POST /tasks/batch rolls back entirely if any task fails validation', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/batch',
      payload: {
        tasks: [
          { title: 'Good task' },
          { title: 'Bad task', files: ['../escape'] },
        ],
      },
    });
    assert.equal(res.statusCode, 400);

    // No tasks should have been created
    const list = await ctx.app.inject({ method: 'GET', url: '/tasks' });
    assert.equal(list.json().length, 0);
  });

  it('POST /tasks rejects unknown fields with 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Test', source_path: 'snake_case_mistake' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('source_path'));
  });

  // ── POST /tasks/claim-next ─────────────────────────────────────────

  it('POST /tasks/claim-next returns null task when no tasks exist', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      headers: { 'x-agent-name': 'agent-1' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.task, null);
    assert.equal(body.pending, 0);
    assert.equal(body.blocked, 0);
  });

  it('POST /tasks/claim-next returns the highest-priority pending task', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Low priority', priority: 1 },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'High priority', priority: 10 },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      headers: { 'x-agent-name': 'agent-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().task.title, 'High priority');
  });

  it('POST /tasks/claim-next returns older task when priorities are equal', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'First', priority: 5 },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Second', priority: 5 },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      headers: { 'x-agent-name': 'agent-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().task.title, 'First');
  });

  it('POST /tasks/claim-next prefers task with no file deps over task with file deps', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Has files', priority: 5, files: ['A.cpp'] },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'No files', priority: 5 },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      headers: { 'x-agent-name': 'agent-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().task.title, 'No files');
  });

  it('POST /tasks/claim-next skips tasks whose files are claimed by another agent', async () => {
    // Create a task with files and claim those files via another task
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Blocker', files: ['Shared.cpp'] },
    });
    const blocker = (await ctx.app.inject({ method: 'GET', url: '/tasks' })).json()[0];
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${blocker.id}/claim`,
      headers: { 'x-agent-name': 'agent-other' },
    });

    // Create a second task that uses the same file
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Blocked task', files: ['Shared.cpp'] },
    });

    // Also create an unblocked task
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Free task' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      headers: { 'x-agent-name': 'agent-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().task.title, 'Free task');
  });

  it('POST /tasks/claim-next returns task whose files are already owned by claiming agent', async () => {
    // Create and claim a task to own the file
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'First task', files: ['Mine.cpp'] },
    });
    const first = (await ctx.app.inject({ method: 'GET', url: '/tasks' })).json()[0];
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${first.id}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${first.id}/complete`,
      payload: { result: { summary: 'done' } },
    });

    // Create second task that uses the same file
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Self-overlap', files: ['Mine.cpp'] },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      headers: { 'x-agent-name': 'agent-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().task.title, 'Self-overlap');
  });

  it('POST /tasks/claim-next returns null with reason when all tasks are file-conflicted', async () => {
    // Create and claim a task to own a file
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Blocker', files: ['Locked.cpp'] },
    });
    const blocker = (await ctx.app.inject({ method: 'GET', url: '/tasks' })).json()[0];
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${blocker.id}/claim`,
      headers: { 'x-agent-name': 'agent-other' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${blocker.id}/complete`,
      payload: { result: { summary: 'done' } },
    });

    // Create a pending task that depends on the locked file
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Blocked', files: ['Locked.cpp'] },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      headers: { 'x-agent-name': 'agent-1' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.task, null);
    assert.equal(body.pending, 1);
    assert.equal(body.blocked, 1);
    assert.ok(body.reason.includes('file conflicts'));
  });

  it('POST /tasks/claim-next atomically claims the task and its files', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Atomic test', files: ['Atomic.cpp', 'Atomic.h'] },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      headers: { 'x-agent-name': 'agent-1' },
    });
    assert.equal(res.statusCode, 200);
    const task = res.json().task;
    assert.equal(task.status, 'claimed');
    assert.equal(task.claimedBy, 'agent-1');

    // Verify via GET
    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${task.id}` });
    assert.equal(get.json().status, 'claimed');
    assert.equal(get.json().claimedBy, 'agent-1');
  });

  it('POST /tasks/claim-next prefers task with fewer new file locks', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Many files', priority: 5, files: ['A.cpp', 'B.cpp', 'C.cpp'] },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'One file', priority: 5, files: ['D.cpp'] },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      headers: { 'x-agent-name': 'agent-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().task.title, 'One file');
  });

  it('POST /tasks/claim-next two sequential calls do not return the same task', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Task A', priority: 5 },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Task B', priority: 5 },
    });

    const res1 = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      headers: { 'x-agent-name': 'agent-1' },
    });
    const res2 = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      headers: { 'x-agent-name': 'agent-2' },
    });
    assert.equal(res1.statusCode, 200);
    assert.equal(res2.statusCode, 200);
    assert.notEqual(res1.json().task.id, res2.json().task.id);
  });

  it('PATCH /tasks/:id rejects unknown fields with 400', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Test' },
    });
    const { id } = post.json();

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { source_path: 'oops' },
    });
    assert.equal(patch.statusCode, 400);
    assert.ok(patch.json().message.includes('source_path'));
  });

  // ── claim-next edge cases ─────────────────────────────────────────

  it('POST /tasks/claim-next without X-Agent-Name header defaults to unknown', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'No header task' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      // no x-agent-name header
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.task);
    assert.equal(body.task.claimedBy, 'unknown');
  });

  it('POST /tasks/claim-next returns full formatted task with files array', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Full format', description: 'desc', priority: 7, files: ['Foo.cpp', 'Bar.h'] },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      headers: { 'x-agent-name': 'agent-1' },
    });
    assert.equal(res.statusCode, 200);
    const task = res.json().task;
    // Verify all expected fields exist
    assert.equal(typeof task.id, 'number');
    assert.equal(task.title, 'Full format');
    assert.equal(task.description, 'desc');
    assert.equal(task.priority, 7);
    assert.equal(task.status, 'claimed');
    assert.equal(task.claimedBy, 'agent-1');
    assert.ok(task.claimedAt);
    assert.ok(task.createdAt);
    assert.equal(task.completedAt, null);
    assert.equal(task.result, null);
    assert.equal(task.progressLog, null);
    assert.ok(Array.isArray(task.files));
    assert.equal(task.files.length, 2);
    assert.ok(task.files.includes('Foo.cpp'));
    assert.ok(task.files.includes('Bar.h'));
  });

  it('POST /tasks/claim-next returns null when only non-pending tasks exist', async () => {
    // Create a task, claim it, complete it -- no pending tasks left
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Already done' },
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
      payload: { result: { summary: 'done' } },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      headers: { 'x-agent-name': 'agent-2' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.task, null);
    assert.equal(body.pending, 0);
    assert.equal(body.blocked, 0);
  });

  it('POST /tasks/claim-next blocked count reflects only tasks blocked for the specific agent', async () => {
    // agent-other claims a task with file Locked.cpp
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Locker', files: ['Locked.cpp'] },
    });
    const locker = (await ctx.app.inject({ method: 'GET', url: '/tasks' })).json()[0];
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${locker.id}/claim`,
      headers: { 'x-agent-name': 'agent-other' },
    });

    // Two pending tasks: one blocked (uses Locked.cpp), one unblocked (uses Locked.cpp but also)
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Blocked for requester', files: ['Locked.cpp'] },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Free task' },
    });

    // agent-requester calls claim-next; should get Free task; blocked=1
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      headers: { 'x-agent-name': 'agent-requester' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().task.title, 'Free task');

    // Now call again -- only the blocked task remains pending
    const res2 = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      headers: { 'x-agent-name': 'agent-requester' },
    });
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.json().task, null);
    assert.equal(res2.json().pending, 1);
    assert.equal(res2.json().blocked, 1);

    // But agent-other should NOT see it as blocked (they own Locked.cpp)
    const res3 = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      headers: { 'x-agent-name': 'agent-other' },
    });
    assert.equal(res3.statusCode, 200);
    // agent-other can claim it since they own the file
    assert.equal(res3.json().task.title, 'Blocked for requester');
  });

  it('POST /tasks/claim-next skips claimed tasks even without file deps', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Already claimed' },
    });
    const first = (await ctx.app.inject({ method: 'GET', url: '/tasks' })).json()[0];
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${first.id}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });

    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Still pending' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      headers: { 'x-agent-name': 'agent-2' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().task.title, 'Still pending');
  });
});
