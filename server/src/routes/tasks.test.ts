import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { createTestApp, createTestConfig, type TestContext } from '../test-helper.js';
import tasksPlugin from './tasks.js';
import agentsPlugin from './agents.js';

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

describe('sourceContent / atomic plan write', () => {
  let ctx: TestContext;
  let tmpBareRepo: string;

  function initBareRepo(tmpDir: string): string {
    const repo = path.join(tmpDir, 'test.git');
    execSync(`git init --bare "${repo}"`);
    const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const initCommit = execSync(`git -C "${repo}" commit-tree ${emptyTree} -m "init"`, { encoding: 'utf-8' }).trim();
    execSync(`git -C "${repo}" update-ref refs/heads/main ${initCommit}`);
    return repo;
  }

  beforeEach(async () => {
    ctx = await createTestApp();
    tmpBareRepo = initBareRepo(ctx.tmpDir);
    const config = createTestConfig({
      server: { port: 9100, ubtLockTimeoutMs: 600000, bareRepoPath: tmpBareRepo },
      tasks: { path: '/tmp/tasks', planBranch: 'main' },
    });
    await ctx.app.register(tasksPlugin, { config });
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.cleanup();
  });

  it('POST /tasks with sourceContent + sourcePath writes file to bare repo and returns commitSha', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        title: 'Plan task',
        sourcePath: 'plans/my-plan.md',
        sourceContent: '# My Plan\nDo the thing.',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.id, 'number');
    assert.equal(typeof body.commitSha, 'string');
    assert.ok(body.commitSha.length > 0);

    // Verify file exists in bare repo
    const fileContent = execSync(`git -C "${tmpBareRepo}" show main:plans/my-plan.md`, { encoding: 'utf-8' });
    assert.equal(fileContent, '# My Plan\nDo the thing.');
  });

  it('POST /tasks with sourceContent but no sourcePath returns 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        title: 'No path',
        sourceContent: '# Content without path',
      },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('sourceContent requires sourcePath'));
  });

  it('POST /tasks with sourcePath only, file exists in bare repo, succeeds', async () => {
    // Write a file first via sourceContent
    const setup = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        title: 'Setup',
        sourcePath: 'plans/exists.md',
        sourceContent: 'existing content',
      },
    });
    assert.equal(setup.statusCode, 200);

    // Now create a task referencing it without sourceContent
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        title: 'Reference existing',
        sourcePath: 'plans/exists.md',
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
    assert.equal(res.json().commitSha, undefined);
  });

  it('POST /tasks with sourcePath only, file missing, returns 422', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        title: 'Missing file',
        sourcePath: 'plans/nonexistent.md',
      },
    });
    assert.equal(res.statusCode, 422);
    assert.ok(res.json().message.includes('not found'));
  });

  it('POST /tasks with nested sourcePath writes file at correct path', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        title: 'Nested plan',
        sourcePath: 'Notes/ui/deep/plan.md',
        sourceContent: 'nested content here',
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(typeof res.json().commitSha, 'string');

    const fileContent = execSync(`git -C "${tmpBareRepo}" show main:Notes/ui/deep/plan.md`, { encoding: 'utf-8' });
    assert.equal(fileContent, 'nested content here');
  });

  it('POST /tasks without sourceContent or sourcePath succeeds (unchanged behavior)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Plain task' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
    assert.equal(res.json().commitSha, undefined);
  });

  it('POST /tasks/batch with mixed sourceContent tasks succeeds', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/batch',
      payload: {
        tasks: [
          { title: 'With content', sourcePath: 'plans/a.md', sourceContent: 'plan A content' },
          { title: 'Without content' },
        ],
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.ids.length, 2);
    assert.ok(Array.isArray(body.commitShas));
    // commitShas is positionally aligned: [sha, null]
    assert.equal(body.commitShas.length, 2);
    assert.equal(typeof body.commitShas[0], 'string');
    assert.equal(body.commitShas[1], null);

    // Verify file in bare repo
    const fileContent = execSync(`git -C "${tmpBareRepo}" show main:plans/a.md`, { encoding: 'utf-8' });
    assert.equal(fileContent, 'plan A content');
  });

  it('POST /tasks/batch commitShas positional alignment: [noContent, withContent]', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/batch',
      payload: {
        tasks: [
          { title: 'No content task' },
          { title: 'With content', sourcePath: 'plans/b.md', sourceContent: 'plan B content' },
        ],
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.ids.length, 2);
    assert.ok(Array.isArray(body.commitShas));
    assert.equal(body.commitShas.length, 2);
    assert.equal(body.commitShas[0], null);
    assert.equal(typeof body.commitShas[1], 'string');
    assert.ok(body.commitShas[1].length > 0);
  });

  it('POST /tasks rejects sourcePath with path traversal', async () => {
    const cases = [
      { sourcePath: '../etc/passwd', label: '..' },
      { sourcePath: '/absolute/path.md', label: 'absolute' },
      { sourcePath: '', label: 'empty' },
    ];
    for (const { sourcePath, label } of cases) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: `Bad sourcePath (${label})`, sourcePath },
      });
      assert.equal(res.statusCode, 400, `Expected 400 for ${label} sourcePath`);
      assert.ok(res.json().message.includes('Invalid sourcePath'), `Expected Invalid sourcePath message for ${label}`);
    }
  });

  it('POST /tasks/batch rejects sourcePath with path traversal', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/batch',
      payload: {
        tasks: [
          { title: 'Good task' },
          { title: 'Bad task', sourcePath: '../escape.md', sourceContent: 'content' },
        ],
      },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('Invalid sourcePath'));
  });

  it('PATCH /tasks/:id with sourceContent returns 400', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Patchable' },
    });
    const { id } = post.json();

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { sourceContent: 'should be rejected' },
    });
    assert.equal(patch.statusCode, 400);
    assert.ok(patch.json().message.includes('sourceContent'));
  });

  it('sourceContent is NOT stored in the task record', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        title: 'Content task',
        sourcePath: 'plans/check.md',
        sourceContent: 'should not be stored',
      },
    });
    const { id } = post.json();

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.equal(task.sourceContent, undefined);
    assert.equal(task.sourcePath, 'plans/check.md');
  });
});

describe('targetAgents / merge into agent branches', () => {
  let ctx: TestContext;
  let tmpBareRepo: string;

  function initBareRepoWithBranch(tmpDir: string, branchName: string): { repo: string; initSha: string } {
    const repo = path.join(tmpDir, 'test.git');
    execSync(`git init --bare "${repo}"`);
    const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const initSha = execSync(`git -C "${repo}" commit-tree ${emptyTree} -m "init"`, { encoding: 'utf-8' }).trim();
    execSync(`git -C "${repo}" update-ref refs/heads/${branchName} ${initSha}`);
    return { repo, initSha };
  }

  beforeEach(async () => {
    ctx = await createTestApp();
    const { repo, initSha } = initBareRepoWithBranch(ctx.tmpDir, 'docker/current-root');
    tmpBareRepo = repo;

    // Create agent branches from the same initial commit
    execSync(`git -C "${tmpBareRepo}" update-ref refs/heads/docker/agent-1 ${initSha}`);
    execSync(`git -C "${tmpBareRepo}" update-ref refs/heads/docker/agent-2 ${initSha}`);

    const config = createTestConfig({
      server: { port: 9100, ubtLockTimeoutMs: 600000, bareRepoPath: tmpBareRepo },
      tasks: { path: '/tmp/tasks', planBranch: 'docker/current-root' },
    });
    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(tasksPlugin, { config });

    // Register agents in DB
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-2', worktree: '/tmp/wt2' },
    });
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.cleanup();
  });

  it('POST /tasks with targetAgents array merges into named agent branch', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        title: 'Plan for agent-1',
        sourcePath: 'plans/my-plan.md',
        sourceContent: '# Plan\nDo the thing.',
        targetAgents: ['agent-1'],
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.ok(body.commitSha);
    assert.deepEqual(body.mergedAgents, ['agent-1']);

    // Verify the plan file exists on docker/agent-1
    const fileContent = execSync(`git -C "${tmpBareRepo}" show docker/agent-1:plans/my-plan.md`, { encoding: 'utf-8' });
    assert.equal(fileContent, '# Plan\nDo the thing.');
  });

  it('POST /tasks with targetAgents "*" merges into all active agent branches', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        title: 'Plan for all',
        sourcePath: 'plans/broadcast.md',
        sourceContent: '# Broadcast plan',
        targetAgents: '*',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.ok(body.mergedAgents);
    assert.ok(body.mergedAgents.includes('agent-1'));
    assert.ok(body.mergedAgents.includes('agent-2'));

    // Verify both branches have the file
    const content1 = execSync(`git -C "${tmpBareRepo}" show docker/agent-1:plans/broadcast.md`, { encoding: 'utf-8' });
    assert.equal(content1, '# Broadcast plan');
    const content2 = execSync(`git -C "${tmpBareRepo}" show docker/agent-2:plans/broadcast.md`, { encoding: 'utf-8' });
    assert.equal(content2, '# Broadcast plan');
  });

  it('POST /tasks without targetAgents does not merge', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        title: 'No merge needed',
        sourcePath: 'plans/solo.md',
        sourceContent: '# Solo plan',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.mergedAgents, undefined);
  });

  it('POST /tasks with targetAgents for nonexistent branch reports failure', async () => {
    // Register agent 'ghost' in DB but do NOT create docker/ghost branch
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'ghost', worktree: '/tmp/ghost' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        title: 'Plan for ghost',
        sourcePath: 'plans/ghost-plan.md',
        sourceContent: '# Ghost plan',
        targetAgents: ['ghost'],
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.ok(body.failedMerges);
    assert.equal(body.failedMerges.length, 1);
    assert.equal(body.failedMerges[0].agent, 'ghost');
    assert.ok(body.failedMerges[0].reason.includes('does not exist'));
  });

  it('POST /tasks with targetAgents but no sourceContent returns 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        title: 'No content',
        targetAgents: ['agent-1'],
      },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('targetAgents requires sourceContent'));
  });

  it('POST /tasks with targetAgents "*" skips agents with done/error status', async () => {
    // Set agent-2 to done
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/agent-2/status',
      payload: { status: 'done' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        title: 'Active only',
        sourcePath: 'plans/active.md',
        sourceContent: '# Active agents only',
        targetAgents: '*',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.mergedAgents, ['agent-1']);
  });

  // ── Task Dependencies ────────────────────────────────────────────────

  describe('task dependencies', () => {
    it('POST /tasks with dependsOn inserts dependency rows and returns them', async () => {
      const r1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Dep A' },
      });
      const depId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Dep B', dependsOn: [depId] },
      });
      assert.equal(r2.statusCode, 200);
      assert.equal(r2.json().ok, true);

      const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${r2.json().id}` });
      const task = get.json();
      assert.deepEqual(task.dependsOn, [depId]);
      assert.deepEqual(task.blockedBy, [depId]);
    });

    it('POST /tasks with dependsOn referencing non-existent task returns 400', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Bad dep', dependsOn: [99999] },
      });
      assert.equal(res.statusCode, 400);
      assert.ok(res.json().message.includes('does not exist'));
    });

    it('POST /tasks/claim-next skips tasks with unmet dependencies', async () => {
      const r1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Blocker' },
      });
      const blockerId = r1.json().id;

      await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Blocked task', dependsOn: [blockerId] },
      });

      const claim = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim.statusCode, 200);
      const body = claim.json();
      assert.ok(body.task);
      assert.equal(body.task.title, 'Blocker');
    });

    it('POST /tasks/claim-next claims task when dependency is completed', async () => {
      const r1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Prereq' },
      });
      const prereqId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Dependent', dependsOn: [prereqId] },
      });
      const depTaskId = r2.json().id;

      // Claim and complete the prereq
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${prereqId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${prereqId}/complete`,
        payload: { result: { done: true } },
      });

      // Now claim-next should pick up the dependent task
      const claim = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claim.statusCode, 200);
      assert.ok(claim.json().task);
      assert.equal(claim.json().task.id, depTaskId);
    });

    it('POST /tasks/:id/claim returns 409 with blockedBy when dependency unmet', async () => {
      const r1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Blocker for claim' },
      });
      const blockerId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Cannot claim yet', dependsOn: [blockerId] },
      });
      const taskId = r2.json().id;

      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim.statusCode, 409);
      const body = claim.json();
      assert.equal(body.message, 'Task has unmet dependencies');
      assert.deepEqual(body.blockedBy, [blockerId]);
    });

    it('POST /tasks/:id/claim succeeds when all dependencies completed', async () => {
      const r1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Prereq for claim' },
      });
      const prereqId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Claimable after prereq', dependsOn: [prereqId] },
      });
      const taskId = r2.json().id;

      // Complete prereq
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${prereqId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${prereqId}/complete`,
        payload: { result: { done: true } },
      });

      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claim.statusCode, 200);
      assert.deepEqual(claim.json(), { ok: true });
    });

    it('POST /tasks/batch with dependsOnIndex resolves cross-references', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/batch',
        payload: {
          tasks: [
            { title: 'Batch A' },
            { title: 'Batch B', dependsOnIndex: [0] },
            { title: 'Batch C', dependsOnIndex: [0, 1] },
          ],
        },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.ids.length, 3);

      // Verify deps
      const getB = await ctx.app.inject({ method: 'GET', url: `/tasks/${body.ids[1]}` });
      assert.deepEqual(getB.json().dependsOn, [body.ids[0]]);

      const getC = await ctx.app.inject({ method: 'GET', url: `/tasks/${body.ids[2]}` });
      assert.deepEqual(getC.json().dependsOn.sort(), [body.ids[0], body.ids[1]].sort());
    });

    it('POST /tasks/batch with dependsOnIndex self-reference returns 400', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/batch',
        payload: {
          tasks: [
            { title: 'Self ref', dependsOnIndex: [0] },
          ],
        },
      });
      assert.equal(res.statusCode, 400);
      assert.ok(res.json().message.includes('self'));
    });

    it('GET /tasks/:id returns dependsOn and blockedBy arrays', async () => {
      const r1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Parent' },
      });
      const parentId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Child', dependsOn: [parentId] },
      });
      const childId = r2.json().id;

      const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${childId}` });
      const task = get.json();
      assert.deepEqual(task.dependsOn, [parentId]);
      assert.deepEqual(task.blockedBy, [parentId]);

      // Complete parent, blockedBy should become empty
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${parentId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${parentId}/complete`,
        payload: { result: {} },
      });

      const get2 = await ctx.app.inject({ method: 'GET', url: `/tasks/${childId}` });
      const task2 = get2.json();
      assert.deepEqual(task2.dependsOn, [parentId]);
      assert.deepEqual(task2.blockedBy, []);
    });

    it('PATCH /tasks/:id with dependsOn updates dependency list', async () => {
      const r1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Dep X' },
      });
      const depX = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Dep Y' },
      });
      const depY = r2.json().id;

      const r3 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Patchable', dependsOn: [depX] },
      });
      const taskId = r3.json().id;

      // Verify initial deps
      const get1 = await ctx.app.inject({ method: 'GET', url: `/tasks/${taskId}` });
      assert.deepEqual(get1.json().dependsOn, [depX]);

      // Patch to new deps
      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/tasks/${taskId}`,
        payload: { dependsOn: [depY] },
      });
      assert.equal(patch.statusCode, 200);

      const get2 = await ctx.app.inject({ method: 'GET', url: `/tasks/${taskId}` });
      assert.deepEqual(get2.json().dependsOn, [depY]);
    });

    it('PATCH /tasks/:id with dependsOn creating a mutual cycle returns 400', async () => {
      const r1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Cycle A' },
      });
      const idA = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Cycle B', dependsOn: [idA] },
      });
      const idB = r2.json().id;

      // Try to make A depend on B — should fail with cycle error
      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/tasks/${idA}`,
        payload: { dependsOn: [idB] },
      });
      assert.equal(patch.statusCode, 400);
      assert.ok(patch.json().message.includes('Cycle detected'));
    });

    it('task with multiple deps where only some are completed remains blocked', async () => {
      // Create two prerequisite tasks
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep 1' } });
      const r2 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep 2' } });
      const dep1 = r1.json().id;
      const dep2 = r2.json().id;

      // Create a task that depends on both
      const r3 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Needs both', dependsOn: [dep1, dep2] },
      });
      const taskId = r3.json().id;

      // Complete only dep1
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep1}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep1}/complete`, payload: { result: { done: true } } });

      // blockedBy should only contain dep2 now
      const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${taskId}` });
      const task = get.json();
      assert.deepEqual(task.dependsOn.sort(), [dep1, dep2].sort());
      assert.deepEqual(task.blockedBy, [dep2]);

      // claim should still fail
      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claim.statusCode, 409);
      assert.deepEqual(claim.json().blockedBy, [dep2]);

      // claim-next should not return the blocked task (should return dep2 instead)
      const claimNext = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claimNext.statusCode, 200);
      assert.equal(claimNext.json().task.title, 'Dep 2');
    });

    it('full lifecycle: complete dependency then claim dependent task', async () => {
      // Create prerequisite
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Prerequisite' } });
      const prereqId = r1.json().id;

      // Create dependent task
      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Dependent task', dependsOn: [prereqId] },
      });
      const depId = r2.json().id;

      // Verify initially blocked
      const claim1 = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${depId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim1.statusCode, 409);

      // Claim, update, complete the prerequisite
      await ctx.app.inject({ method: 'POST', url: `/tasks/${prereqId}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${prereqId}/update`, payload: { progress: 'Working on it' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${prereqId}/complete`, payload: { result: { summary: 'All done' } } });

      // Now the dependent task should be claimable
      const claim2 = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${depId}/claim`,
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claim2.statusCode, 200);
      assert.deepEqual(claim2.json(), { ok: true });

      // Verify the claimed state
      const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${depId}` });
      const task = get.json();
      assert.equal(task.status, 'claimed');
      assert.equal(task.claimedBy, 'agent-2');
      assert.deepEqual(task.dependsOn, [prereqId]);
      assert.deepEqual(task.blockedBy, []);
    });

    it('GET /tasks list returns dependsOn and blockedBy for all tasks', async () => {
      // Create tasks: one independent, one with dependency
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Independent' } });
      const indepId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Has dependency', dependsOn: [indepId] },
      });

      const list = await ctx.app.inject({ method: 'GET', url: '/tasks' });
      assert.equal(list.statusCode, 200);
      const tasks = list.json();
      assert.equal(tasks.length, 2);

      // Independent task should have empty arrays
      const indepTask = tasks.find((t: any) => t.title === 'Independent');
      assert.ok(indepTask);
      assert.deepEqual(indepTask.dependsOn, []);
      assert.deepEqual(indepTask.blockedBy, []);

      // Dependent task should have populated arrays
      const depTask = tasks.find((t: any) => t.title === 'Has dependency');
      assert.ok(depTask);
      assert.deepEqual(depTask.dependsOn, [indepId]);
      assert.deepEqual(depTask.blockedBy, [indepId]);
    });

    it('POST /tasks/batch with dependsOnIndex forming a chain A -> B -> C', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/batch',
        payload: {
          tasks: [
            { title: 'Chain A' },
            { title: 'Chain B', dependsOnIndex: [0] },
            { title: 'Chain C', dependsOnIndex: [1] },
          ],
        },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      const [idA, idB, idC] = body.ids;

      // Verify the chain
      const getA = await ctx.app.inject({ method: 'GET', url: `/tasks/${idA}` });
      assert.deepEqual(getA.json().dependsOn, []);
      assert.deepEqual(getA.json().blockedBy, []);

      const getB = await ctx.app.inject({ method: 'GET', url: `/tasks/${idB}` });
      assert.deepEqual(getB.json().dependsOn, [idA]);
      assert.deepEqual(getB.json().blockedBy, [idA]);

      const getC = await ctx.app.inject({ method: 'GET', url: `/tasks/${idC}` });
      assert.deepEqual(getC.json().dependsOn, [idB]);
      assert.deepEqual(getC.json().blockedBy, [idB]);

      // claim-next should only return A (B and C are blocked)
      const claim1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim1.json().task.title, 'Chain A');

      // Complete directly from 'claimed' — the server permits this transition.
      // If status constraints are tightened in the future, add an /update step here.
      // Complete A, then B should become claimable but C should still be blocked
      await ctx.app.inject({ method: 'POST', url: `/tasks/${idA}/complete`, payload: { result: {} } });

      const claim2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claim2.json().task.title, 'Chain B');

      // C is still blocked by B
      const getC2 = await ctx.app.inject({ method: 'GET', url: `/tasks/${idC}` });
      assert.deepEqual(getC2.json().blockedBy, [idB]);
    });

    it('PATCH /tasks/:id with dependsOn: [] clears dependencies and makes task claimable', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Blocker' } });
      const blockerId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Was blocked', dependsOn: [blockerId] },
      });
      const taskId = r2.json().id;

      // Verify it is blocked
      const claim1 = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim1.statusCode, 409);

      // Clear dependencies
      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/tasks/${taskId}`,
        payload: { dependsOn: [] },
      });
      assert.equal(patch.statusCode, 200);

      // Verify dependencies are cleared
      const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${taskId}` });
      assert.deepEqual(get.json().dependsOn, []);
      assert.deepEqual(get.json().blockedBy, []);

      // Now it should be claimable
      const claim2 = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim2.statusCode, 200);
      assert.deepEqual(claim2.json(), { ok: true });
    });

    it('POST /tasks rejects dependsOnIndex in single create', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Bad', dependsOnIndex: [0] },
      });
      assert.equal(res.statusCode, 400);
      assert.ok(res.json().message.includes('dependsOnIndex is only valid in POST /tasks/batch'));
    });

    it('POST /tasks/batch with mutual dependsOnIndex cycle returns 400', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/batch',
        payload: {
          tasks: [
            { title: 'A', dependsOnIndex: [1] },
            { title: 'B', dependsOnIndex: [0] },
          ],
        },
      });
      assert.equal(res.statusCode, 400);
      assert.ok(res.json().message.includes('Cycle detected'));
    });

    it('PATCH /tasks/:id with dependsOn containing self-reference returns 400', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Self dep' } });
      const taskId = r1.json().id;

      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/tasks/${taskId}`,
        payload: { dependsOn: [taskId] },
      });
      assert.equal(patch.statusCode, 400);
      assert.ok(patch.json().message.includes('cannot depend on itself'));
    });

    it('claim-next depBlocked count reflects tasks blocked by dependencies', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Blocker task' } });
      const blockerId = r1.json().id;

      // Claim the blocker so it is no longer pending
      await ctx.app.inject({ method: 'POST', url: `/tasks/${blockerId}/claim`, headers: { 'x-agent-name': 'agent-1' } });

      // Create a task blocked by the dependency
      await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Dep blocked', dependsOn: [blockerId] },
      });

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.task, null);
      assert.equal(body.pending, 1);
      assert.equal(body.depBlocked, 1);
      assert.ok(body.reason.includes('unmet dependencies'));
    });
  });
});
