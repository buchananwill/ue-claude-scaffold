import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createTestApp, createTestConfig, type TestContext } from '../test-helper.js';
import { db, openDb } from '../db.js';
import Database from 'better-sqlite3';
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

  it('POST /tasks with nested sourcePath preserves sibling files (regression: data loss bug)', async () => {
    // Seed the bare repo with two existing files under Notes/
    await ctx.app.inject({
      method: 'POST', url: '/tasks',
      payload: { title: 'Seed A', sourcePath: 'Notes/design/doc-a.md', sourceContent: 'doc A content' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/tasks',
      payload: { title: 'Seed B', sourcePath: 'Notes/design/doc-b.md', sourceContent: 'doc B content' },
    });
    // Also seed a sibling directory
    await ctx.app.inject({
      method: 'POST', url: '/tasks',
      payload: { title: 'Seed C', sourcePath: 'Notes/plans/existing.md', sourceContent: 'existing plan' },
    });

    // Now write a new file under a different Notes/ subdirectory
    const res = await ctx.app.inject({
      method: 'POST', url: '/tasks',
      payload: { title: 'New plan', sourcePath: 'Notes/plans/new-plan.md', sourceContent: 'new plan content' },
    });
    assert.equal(res.statusCode, 200);

    // All pre-existing files must still be present
    const docA = execSync(`git -C "${tmpBareRepo}" show main:Notes/design/doc-a.md`, { encoding: 'utf-8' });
    assert.equal(docA, 'doc A content');
    const docB = execSync(`git -C "${tmpBareRepo}" show main:Notes/design/doc-b.md`, { encoding: 'utf-8' });
    assert.equal(docB, 'doc B content');
    const existing = execSync(`git -C "${tmpBareRepo}" show main:Notes/plans/existing.md`, { encoding: 'utf-8' });
    assert.equal(existing, 'existing plan');

    // The new file must also exist
    const newPlan = execSync(`git -C "${tmpBareRepo}" show main:Notes/plans/new-plan.md`, { encoding: 'utf-8' });
    assert.equal(newPlan, 'new plan content');

    // Verify Notes/ tree has both subdirectories
    const notesTree = execSync(`git -C "${tmpBareRepo}" ls-tree main Notes/`, { encoding: 'utf-8' });
    assert.ok(notesTree.includes('design'), 'Notes/design should still exist');
    assert.ok(notesTree.includes('plans'), 'Notes/plans should still exist');
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

      // Claim and complete the prereq (same agent will claim the dependent)
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${prereqId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${prereqId}/complete`,
        payload: { result: { done: true, agent: 'agent-1' } },
      });

      // Now claim-next as same agent should pick up the dependent task
      const claim = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-1' },
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

    it('POST /tasks/:id/claim succeeds when all dependencies completed by same agent', async () => {
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

      // Complete prereq as agent-1
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${prereqId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${prereqId}/complete`,
        payload: { result: { done: true, agent: 'agent-1' } },
      });

      // Claim as same agent (agent-1) — branch-aware: dep completed by same agent is met
      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
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

      // Complete parent with agent tag, blockedBy should become empty for same agent
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${parentId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${parentId}/complete`,
        payload: { result: { agent: 'agent-1' } },
      });

      // GET as agent-1 (who completed the parent) — blockedBy should be empty
      const get2 = await ctx.app.inject({
        method: 'GET',
        url: `/tasks/${childId}`,
        headers: { 'x-agent-name': 'agent-1' },
      });
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

      // Complete only dep1 as agent-1
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep1}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep1}/complete`, payload: { result: { done: true, agent: 'agent-1' } } });

      // blockedBy (viewed as agent-1) should only contain dep2 now
      const get = await ctx.app.inject({
        method: 'GET',
        url: `/tasks/${taskId}`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      const task = get.json();
      assert.deepEqual(task.dependsOn.sort(), [dep1, dep2].sort());
      assert.deepEqual(task.blockedBy, [dep2]);

      // claim as agent-1 should still fail (dep2 is still pending)
      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim.statusCode, 409);
      assert.deepEqual(claim.json().blockedBy, [dep2]);

      // claim-next as agent-1 should not return the blocked task (should return dep2 instead)
      const claimNext = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claimNext.statusCode, 200);
      assert.equal(claimNext.json().task.title, 'Dep 2');
    });

    it('full lifecycle: complete dependency then claim dependent task (same agent)', async () => {
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

      // Claim, update, complete the prerequisite as agent-1
      await ctx.app.inject({ method: 'POST', url: `/tasks/${prereqId}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${prereqId}/update`, payload: { progress: 'Working on it' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${prereqId}/complete`, payload: { result: { summary: 'All done', agent: 'agent-1' } } });

      // Now the dependent task should be claimable by the same agent
      const claim2 = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${depId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim2.statusCode, 200);
      assert.deepEqual(claim2.json(), { ok: true });

      // Verify the claimed state (pass agent-1 header so blockedBy is evaluated from agent-1's perspective)
      const get = await ctx.app.inject({
        method: 'GET',
        url: `/tasks/${depId}`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      const task = get.json();
      assert.equal(task.status, 'claimed');
      assert.equal(task.claimedBy, 'agent-1');
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

    describe('blockReasons field', () => {
      it('pending task with no conflicts and no deps has empty blockReasons', async () => {
        const post = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Clean task' },
        });
        const { id } = post.json();

        const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
        const task = get.json();
        assert.equal(task.status, 'pending');
        assert.deepEqual(task.blockReasons, []);
      });

      it('pending task with files locked by another agent has file-lock block reason', async () => {
        // Create and claim a task to lock files
        const r1 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Locker', files: ['Widget.cpp', 'Widget.h'] },
        });
        const lockerId = r1.json().id;
        await ctx.app.inject({
          method: 'POST',
          url: `/tasks/${lockerId}/claim`,
          headers: { 'x-agent-name': 'agent-1' },
        });

        // Create a pending task that needs the same files
        const r2 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Blocked by files', files: ['Widget.cpp'] },
        });
        const blockedId = r2.json().id;

        const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${blockedId}` });
        const task = get.json();
        assert.equal(task.status, 'pending');
        assert.ok(task.blockReasons.length > 0);
        assert.ok(task.blockReasons.some((r: string) => r.includes("files locked by agent 'agent-1'")));
        assert.ok(task.blockReasons.some((r: string) => r.includes('Widget.cpp')));
      });

      it('pending task with unmet dependency has dependency block reason', async () => {
        const r1 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Prereq' },
        });
        const prereqId = r1.json().id;

        const r2 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Dep task', dependsOn: [prereqId] },
        });
        const depTaskId = r2.json().id;

        const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${depTaskId}` });
        const task = get.json();
        assert.equal(task.status, 'pending');
        assert.ok(task.blockReasons.length > 0);
        assert.ok(task.blockReasons.some((r: string) => r.includes('blocked by incomplete task(s)')));
        assert.ok(task.blockReasons.some((r: string) => r.includes(`#${prereqId}`)));
      });

      it('pending task with missing sourcePath has sourcePath block reason', async () => {
        const post = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Missing source task' },
        });
        const { id } = post.json();

        // Bypass route validation by directly setting source_path in the DB
        db.prepare('UPDATE tasks SET source_path = ? WHERE id = ?').run('plans/nonexistent.md', id);

        const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
        const task = get.json();
        assert.equal(task.status, 'pending');
        assert.ok(task.blockReasons.length > 0);
        assert.ok(task.blockReasons.some((r: string) => r.includes('sourcePath')));
        assert.ok(task.blockReasons.some((r: string) => r.includes('not found')));
      });

      it('completed task has empty blockReasons regardless of deps', async () => {
        const r1 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Done prereq' },
        });
        const prereqId = r1.json().id;

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

        const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${prereqId}` });
        const task = get.json();
        assert.equal(task.status, 'completed');
        assert.deepEqual(task.blockReasons, []);
      });

      it('pending task with BOTH file conflict and unmet dependency has multiple block reasons', async () => {
        // Create a task and claim it to lock files
        const r1 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'File locker', files: ['Shared.cpp'] },
        });
        const lockerId = r1.json().id;
        await ctx.app.inject({
          method: 'POST',
          url: `/tasks/${lockerId}/claim`,
          headers: { 'x-agent-name': 'agent-lock' },
        });

        // Create an incomplete prereq task
        const r2 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Prereq task' },
        });
        const prereqId = r2.json().id;

        // Create a task that has both a file conflict AND a dependency blocker
        const r3 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Doubly blocked', files: ['Shared.cpp'], dependsOn: [prereqId] },
        });
        const blockedId = r3.json().id;

        const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${blockedId}` });
        const task = get.json();
        assert.equal(task.status, 'pending');
        // Should have at least 2 reasons: file lock + dependency
        assert.ok(task.blockReasons.length >= 2, `Expected >= 2 block reasons, got ${task.blockReasons.length}`);
        assert.ok(task.blockReasons.some((r: string) => r.includes("files locked by agent 'agent-lock'")));
        assert.ok(task.blockReasons.some((r: string) => r.includes('Shared.cpp')));
        assert.ok(task.blockReasons.some((r: string) => r.includes('blocked by incomplete task(s)')));
        assert.ok(task.blockReasons.some((r: string) => r.includes(`#${prereqId}`)));
      });

      it('GET /tasks list includes blockReasons on every task', async () => {
        // Create a prereq (pending, no blocks)
        const r1 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Independent' },
        });
        const indId = r1.json().id;

        // Create a task blocked by the prereq
        const r2 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Dependent', dependsOn: [indId] },
        });
        const depId = r2.json().id;

        const list = await ctx.app.inject({ method: 'GET', url: '/tasks' });
        const tasks = list.json();
        assert.equal(tasks.length, 2);

        // Every task in the list should have a blockReasons array
        for (const t of tasks) {
          assert.ok(Array.isArray(t.blockReasons), `Task ${t.id} missing blockReasons array`);
        }

        // Independent task should have no block reasons
        const indTask = tasks.find((t: any) => t.id === indId);
        assert.deepEqual(indTask.blockReasons, []);

        // Dependent task should show blocked
        const depTask = tasks.find((t: any) => t.id === depId);
        assert.ok(depTask.blockReasons.length > 0);
        assert.ok(depTask.blockReasons.some((r: string) => r.includes('blocked by incomplete task(s)')));
      });

      it('block reasons disappear after the blocking condition is resolved', async () => {
        // Create a prereq task
        const r1 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Prereq to complete' },
        });
        const prereqId = r1.json().id;

        // Create a dependent task
        const r2 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Waiting on prereq', dependsOn: [prereqId] },
        });
        const waiterId = r2.json().id;

        // Confirm it is blocked initially
        const getBefore = await ctx.app.inject({ method: 'GET', url: `/tasks/${waiterId}` });
        const before = getBefore.json();
        assert.ok(before.blockReasons.length > 0, 'Should be blocked before prereq completes');
        assert.ok(before.blockReasons.some((r: string) => r.includes('blocked by incomplete task(s)')));

        // Now complete the prereq as agent-resolver
        await ctx.app.inject({
          method: 'POST',
          url: `/tasks/${prereqId}/claim`,
          headers: { 'x-agent-name': 'agent-resolver' },
        });
        await ctx.app.inject({
          method: 'POST',
          url: `/tasks/${prereqId}/complete`,
          payload: { result: { done: true, agent: 'agent-resolver' } },
        });

        // Re-fetch the dependent task as agent-resolver -- block reason should be gone
        const getAfter = await ctx.app.inject({
          method: 'GET',
          url: `/tasks/${waiterId}`,
          headers: { 'x-agent-name': 'agent-resolver' },
        });
        const after = getAfter.json();
        assert.equal(after.status, 'pending');
        assert.deepEqual(after.blockReasons, [], 'Block reasons should be empty after prereq is completed by same agent');
      });
    });

    it('claim-next prefers chain continuation over higher priority independent task', async () => {
      // Create task A (priority 5, no deps)
      const rA = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Task A', priority: 5 },
      });
      const idA = rA.json().id;

      // Create task B (priority 5, depends on A)
      const rB = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Task B', priority: 5, dependsOn: [idA] },
      });
      const idB = rB.json().id;

      // Create task C (priority 10, no deps)
      const rC = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Task C', priority: 10 },
      });
      const idC = rC.json().id;

      // Agent-1 claims A and completes it with result.agent = 'agent-1'
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${idA}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${idA}/complete`,
        payload: { result: { summary: 'done', agent: 'agent-1' } },
      });

      // claim-next as agent-1 should return B (chain continuation beats C's higher priority)
      const claim1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim1.statusCode, 200);
      assert.equal(claim1.json().task.id, idB, 'agent-1 should get task B (chain continuation)');
      assert.equal(claim1.json().task.title, 'Task B');

      // claim-next as agent-2 should return C (B is already claimed, C is highest priority remaining)
      const claim2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claim2.statusCode, 200);
      assert.equal(claim2.json().task.id, idC, 'agent-2 should get task C');
      assert.equal(claim2.json().task.title, 'Task C');
    });

    it('integrated deps resume normal priority ordering', async () => {
      // Create task A (priority 5, no deps)
      const rA = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Task A', priority: 5 },
      });
      const idA = rA.json().id;

      // Create task B (priority 5, depends on A)
      const rB = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Task B', priority: 5, dependsOn: [idA] },
      });
      const idB = rB.json().id;

      // Create task C (priority 10, no deps)
      const rC = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Task C', priority: 10 },
      });
      const idC = rC.json().id;

      // Agent-1 claims A, completes it, then integrates it
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${idA}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${idA}/complete`,
        payload: { result: { summary: 'done', agent: 'agent-1' } },
      });
      const intRes = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${idA}/integrate`,
      });
      assert.equal(intRes.statusCode, 200, 'integrate should succeed');

      // claim-next as agent-1: A is integrated, so preference tier does NOT fire.
      // Normal priority ordering applies: C (priority 10) beats B (priority 5).
      const claim1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim1.statusCode, 200);
      assert.equal(claim1.json().task.id, idC, 'agent-1 should get task C (higher priority, no chain preference after integrate)');
      assert.equal(claim1.json().task.title, 'Task C');
    });
  });

  describe('branch-aware dependency resolution', () => {
    it('agent-2 cannot claim task whose dep was completed by agent-1', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep task' } });
      const depId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Blocked task', dependsOn: [depId] },
      });
      const blockedId = r2.json().id;

      // Complete dep as agent-1
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/complete`, payload: { result: { agent: 'agent-1' } } });

      // agent-2 tries to claim the blocked task — should be denied (work on another branch)
      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${blockedId}/claim`,
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claim.statusCode, 409);
      assert.equal(claim.json().message, 'Task has unmet dependencies');
    });

    it('agent-1 can claim task whose dep was completed by agent-1', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep task' } });
      const depId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Blocked task', dependsOn: [depId] },
      });
      const blockedId = r2.json().id;

      // Complete dep as agent-1
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/complete`, payload: { result: { agent: 'agent-1' } } });

      // agent-1 claims the blocked task — should succeed (same branch)
      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${blockedId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim.statusCode, 200);
      assert.deepEqual(claim.json(), { ok: true });
    });

    it('any agent can claim task whose dep is integrated', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep task' } });
      const depId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Blocked task', dependsOn: [depId] },
      });
      const blockedId = r2.json().id;

      // Complete dep as agent-1, then integrate it
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/complete`, payload: { result: { agent: 'agent-1' } } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/integrate` });

      // agent-2 claims the blocked task — should succeed (dep is integrated, available to all)
      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${blockedId}/claim`,
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claim.statusCode, 200);
      assert.deepEqual(claim.json(), { ok: true });
    });

    it('mixed deps: one integrated + one completed by requesting agent is claimable', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep 1' } });
      const dep1 = r1.json().id;
      const r2 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep 2' } });
      const dep2 = r2.json().id;

      const r3 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Needs both', dependsOn: [dep1, dep2] },
      });
      const taskId = r3.json().id;

      // Complete dep1 as agent-1 and integrate it
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep1}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep1}/complete`, payload: { result: { agent: 'agent-1' } } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep1}/integrate` });

      // Complete dep2 as agent-1 (not integrated)
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep2}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep2}/complete`, payload: { result: { agent: 'agent-1' } } });

      // agent-1 claims — should succeed (dep1 integrated, dep2 completed by same agent)
      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim.statusCode, 200);
      assert.deepEqual(claim.json(), { ok: true });
    });

    it('mixed deps: one integrated + one completed by different agent is not claimable', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep 1' } });
      const dep1 = r1.json().id;
      const r2 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep 2' } });
      const dep2 = r2.json().id;

      const r3 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Needs both', dependsOn: [dep1, dep2] },
      });
      const taskId = r3.json().id;

      // dep1: completed by agent-1, integrated
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep1}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep1}/complete`, payload: { result: { agent: 'agent-1' } } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep1}/integrate` });

      // dep2: completed by agent-1 (not integrated)
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep2}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep2}/complete`, payload: { result: { agent: 'agent-1' } } });

      // agent-2 tries to claim — should fail (dep2 completed by agent-1, not integrated)
      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claim.statusCode, 409);
      const body = claim.json();
      assert.ok(body.blockReasons.some((r: string) => r.includes('blocked by work on another branch')));
      // Should NOT say "blocked by incomplete" — dep2 IS completed, just on the wrong branch
      assert.ok(!body.blockReasons.some((r: string) => r.includes('blocked by incomplete')));
    });

    it('claim-next skips task whose dep was completed by different agent', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep task' } });
      const depId = r1.json().id;

      await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Blocked task', dependsOn: [depId] },
      });

      // Complete dep as agent-1
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/complete`, payload: { result: { agent: 'agent-1' } } });

      // claim-next as agent-2 — should not return the blocked task
      const claim = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claim.statusCode, 200);
      assert.equal(claim.json().task, null);
    });

    it('claim-next returns task when dep completed by same agent', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep task' } });
      const depId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Blocked task', dependsOn: [depId] },
      });
      const blockedId = r2.json().id;

      // Complete dep as agent-1
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/complete`, payload: { result: { agent: 'agent-1' } } });

      // claim-next as agent-1 — should return the blocked task
      const claim = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim.statusCode, 200);
      assert.ok(claim.json().task);
      assert.equal(claim.json().task.id, blockedId);
    });

    it('blockedBy in 409 response includes blockReasons distinguishing branch vs incomplete', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Pending dep' } });
      const pendingDepId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Blocked task', dependsOn: [pendingDepId] },
      });
      const blockedId = r2.json().id;

      // Claim the blocked task while dep is still pending — should get "blocked by incomplete"
      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${blockedId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim.statusCode, 409);
      const body = claim.json();
      assert.ok(body.blockReasons.some((r: string) => r.includes('blocked by incomplete task(s)')));
      assert.ok(body.blockReasons.some((r: string) => r.includes(`#${pendingDepId}`)));
    });
  });

  describe('v8 schema — integrated and cycle statuses', () => {
    it('accepts integrated status on direct insert', () => {
      const stmt = db.prepare("INSERT INTO tasks (title, status) VALUES (?, 'integrated')");
      const info = stmt.run('Integrated task');
      assert.equal(info.changes, 1);

      const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(info.lastInsertRowid) as { status: string };
      assert.equal(row.status, 'integrated');
    });

    it('accepts cycle status on direct insert', () => {
      const stmt = db.prepare("INSERT INTO tasks (title, status) VALUES (?, 'cycle')");
      const info = stmt.run('Cycle task');
      assert.equal(info.changes, 1);

      const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(info.lastInsertRowid) as { status: string };
      assert.equal(row.status, 'cycle');
    });

    it('rejects invalid status values', () => {
      assert.throws(() => {
        db.prepare("INSERT INTO tasks (title, status) VALUES (?, 'invalid')").run('Bad task');
      }, /CHECK constraint failed/);
    });

    it('CHECK constraint includes all expected statuses', () => {
      const validStatuses = ['pending', 'claimed', 'in_progress', 'completed', 'failed', 'integrated', 'cycle'];
      for (const status of validStatuses) {
        const info = db.prepare('INSERT INTO tasks (title, status) VALUES (?, ?)').run(`Task ${status}`, status);
        assert.equal(info.changes, 1, `Status '${status}' should be accepted`);
      }
    });

    it('schema_version is 9 on fresh database', () => {
      const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
      assert.equal(row.version, 9);
    });
  });

  describe('v7 to v9 migration', () => {
    it('openDb on a v7 database migrates CHECK constraint via writable_schema to v9', () => {
      const v7TmpDir = mkdtempSync(path.join(tmpdir(), 'scaffold-v7-'));
      const v7DbPath = path.join(v7TmpDir, 'v7.db');
      const v7db = new Database(v7DbPath);
      v7db.pragma('journal_mode = WAL');

      // Create a realistic v7 schema: tasks table with the old CHECK constraint
      // that lacks 'integrated' and 'cycle', plus all other tables that SCHEMA_SQL
      // expects to exist (so CREATE TABLE IF NOT EXISTS is a no-op for them).
      v7db.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
        INSERT INTO schema_version(version) VALUES (7);

        CREATE TABLE agents (
          name        TEXT PRIMARY KEY,
          worktree    TEXT NOT NULL,
          plan_doc    TEXT,
          status      TEXT NOT NULL DEFAULT 'idle',
          mode        TEXT NOT NULL DEFAULT 'single',
          registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE ubt_lock (
          id          INTEGER PRIMARY KEY CHECK (id = 1),
          holder      TEXT,
          acquired_at DATETIME,
          priority    INTEGER DEFAULT 0
        );

        CREATE TABLE ubt_queue (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          agent       TEXT NOT NULL,
          priority    INTEGER DEFAULT 0,
          requested_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE build_history (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          agent        TEXT NOT NULL,
          type         TEXT NOT NULL CHECK (type IN ('build', 'test')),
          started_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          duration_ms  INTEGER,
          success      INTEGER,
          output       TEXT,
          stderr       TEXT
        );

        CREATE TABLE messages (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          from_agent  TEXT NOT NULL,
          channel     TEXT NOT NULL,
          type        TEXT NOT NULL,
          payload     TEXT NOT NULL,
          claimed_by  TEXT,
          claimed_at  DATETIME,
          resolved_at DATETIME,
          result      TEXT,
          created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX idx_messages_channel ON messages(channel);
        CREATE INDEX idx_messages_channel_id ON messages(channel, id);
        CREATE INDEX idx_messages_claimed ON messages(claimed_by);

        CREATE TABLE tasks (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          title               TEXT NOT NULL,
          description         TEXT DEFAULT '',
          source_path         TEXT,
          acceptance_criteria TEXT,
          status              TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','claimed','in_progress','completed','failed')),
          priority            INTEGER NOT NULL DEFAULT 0,
          claimed_by          TEXT,
          claimed_at          DATETIME,
          completed_at        DATETIME,
          result              TEXT,
          progress_log        TEXT,
          created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX idx_tasks_status ON tasks(status);
        CREATE INDEX idx_tasks_priority ON tasks(priority DESC, id ASC);

        CREATE TABLE files (
          path       TEXT PRIMARY KEY,
          claimant   TEXT,
          claimed_at DATETIME
        );

        CREATE TABLE task_files (
          task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          file_path  TEXT NOT NULL REFERENCES files(path),
          PRIMARY KEY (task_id, file_path)
        );
        CREATE INDEX idx_task_files_path ON task_files(file_path);

        CREATE TABLE task_dependencies (
          task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          depends_on  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          PRIMARY KEY (task_id, depends_on),
          CHECK (task_id != depends_on)
        );
        CREATE INDEX idx_task_deps_task ON task_dependencies(task_id);
        CREATE INDEX idx_task_deps_dep  ON task_dependencies(depends_on);
      `);

      // Seed a pre-existing row to verify data survives
      v7db.prepare("INSERT INTO tasks (title, status) VALUES ('Existing task', 'completed')").run();

      // Confirm the old constraint rejects 'integrated' before migration
      assert.throws(() => {
        v7db.prepare("INSERT INTO tasks (title, status) VALUES ('x', 'integrated')").run();
      }, /CHECK constraint/, 'v7 schema should reject integrated status');

      v7db.close();

      // Run openDb which should migrate via writable_schema
      let migratedDb: ReturnType<typeof openDb>;
      try {
        migratedDb = openDb(v7DbPath);
      } catch (e: any) {
        console.error('openDb failed:', e.message, e.code);
        throw e;
      }

      // 1. schema_version bumped to 9 (old version 7 row deleted)
      const row = migratedDb.prepare('SELECT version FROM schema_version').get() as any;
      assert.strictEqual(row.version, 9, 'Schema version should be 9 after migration');

      // 2. Existing data survived
      const task = migratedDb.prepare("SELECT title, status FROM tasks WHERE title = 'Existing task'").get() as any;
      assert.ok(task, 'Existing task should survive migration');
      assert.strictEqual(task.status, 'completed');

      // 3. New statuses accepted (writable_schema rewrote the CHECK constraint)
      assert.doesNotThrow(() => {
        migratedDb.prepare("INSERT INTO tasks (title, status) VALUES ('integrated task', 'integrated')").run();
      }, 'integrated status should be accepted after migration');

      assert.doesNotThrow(() => {
        migratedDb.prepare("INSERT INTO tasks (title, status) VALUES ('cycle task', 'cycle')").run();
      }, 'cycle status should be accepted after migration');

      // 4. Invalid statuses still rejected
      assert.throws(() => {
        migratedDb.prepare("INSERT INTO tasks (title, status) VALUES ('bad task', 'invalid')").run();
      }, /CHECK constraint/, 'invalid status should still be rejected after migration');

      // 5. Verify the CHECK constraint in sqlite_master was actually rewritten
      const schema = migratedDb.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'"
      ).get() as any;
      assert.ok(schema.sql.includes("'integrated'"), 'CHECK constraint should include integrated');
      assert.ok(schema.sql.includes("'cycle'"), 'CHECK constraint should include cycle');

      // 6. Verify base_priority column was added by migration
      migratedDb.prepare("INSERT INTO tasks (title, priority, base_priority) VALUES ('bp test', 5, 5)").run();
      const bpTask = migratedDb.prepare("SELECT base_priority FROM tasks WHERE title = 'bp test'").get() as any;
      assert.strictEqual(bpTask.base_priority, 5, 'base_priority column should exist after migration');

      migratedDb.close();

      // Cleanup
      try { unlinkSync(v7DbPath); } catch {}
      try { unlinkSync(v7DbPath + '-wal'); } catch {}
      try { unlinkSync(v7DbPath + '-shm'); } catch {}
      try { rmdirSync(v7TmpDir); } catch {}
    });
  });

  // ── Phase 2: integrate endpoints ──────────────────────────────────────

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
    async function createCompletedTaskWithAgent(app: typeof ctx.app, agent: string) {
      const post = await app.inject({ method: 'POST', url: '/tasks', payload: { title: `Task by ${agent}` } });
      const id = post.json().id;
      await app.inject({ method: 'POST', url: `/tasks/${id}/claim`, headers: { 'x-agent-name': agent } });
      await app.inject({ method: 'POST', url: `/tasks/${id}/complete`, payload: { result: { summary: 'done', agent } } });
      return id;
    }

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
    async function createCompletedTaskWithAgent(app: typeof ctx.app, agent: string) {
      const post = await app.inject({ method: 'POST', url: '/tasks', payload: { title: `Task by ${agent}` } });
      const id = post.json().id;
      await app.inject({ method: 'POST', url: `/tasks/${id}/claim`, headers: { 'x-agent-name': agent } });
      await app.inject({ method: 'POST', url: `/tasks/${id}/complete`, payload: { result: { summary: 'done', agent } } });
      return id;
    }

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
      const tasks = res.json();
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

  describe('POST /tasks/replan', () => {
    /** Helper: create a task and return its id */
    async function createTask(title: string, priority?: number, dependsOn?: number[]): Promise<number> {
      const payload: Record<string, unknown> = { title };
      if (priority !== undefined) payload.priority = priority;
      if (dependsOn !== undefined) payload.dependsOn = dependsOn;
      const res = await ctx.app.inject({ method: 'POST', url: '/tasks', payload });
      assert.equal(res.statusCode, 200, `createTask '${title}' failed: ${res.body}`);
      return res.json().id;
    }

    /** Helper: add a dependency edge via direct DB insert (needed for cycles) */
    function addDep(taskId: number, dependsOn: number): void {
      db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on) VALUES (?, ?)').run(taskId, dependsOn);
    }

    it('empty queue returns zero counts', async () => {
      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.deepEqual(body, { ok: true, replanned: 0, cycles: [], maxPriority: 0, roots: [] });
    });

    it('tasks with no dependencies returns all as roots with unchanged priorities', async () => {
      const idA = await createTask('A', 1);
      const idB = await createTask('B', 2);
      const idC = await createTask('C', 3);

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);
      const body = res.json();

      assert.equal(body.ok, true);
      assert.equal(body.replanned, 3);
      assert.deepEqual(body.cycles, []);
      assert.deepEqual(body.roots.sort((a: number, b: number) => a - b), [idA, idB, idC].sort((a, b) => a - b));

      // Verify priorities unchanged by fetching each task
      const tA = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idA}` })).json();
      const tB = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idB}` })).json();
      const tC = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idC}` })).json();
      assert.equal(tA.priority, 1);
      assert.equal(tB.priority, 2);
      assert.equal(tC.priority, 3);
    });

    it('detects three-node cycle A->B->C->A', async () => {
      const idA = await createTask('A', 1);
      const idB = await createTask('B', 1);
      const idC = await createTask('C', 1);

      // A depends on B, B depends on C, C depends on A
      addDep(idA, idB);
      addDep(idB, idC);
      addDep(idC, idA);

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);
      const body = res.json();

      // All three should be in a cycle
      const tA = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idA}` })).json();
      const tB = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idB}` })).json();
      const tC = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idC}` })).json();
      assert.equal(tA.status, 'cycle');
      assert.equal(tB.status, 'cycle');
      assert.equal(tC.status, 'cycle');

      assert.equal(body.cycles.length, 1);
      const cycleTaskIds = body.cycles[0].taskIds.sort((a: number, b: number) => a - b);
      assert.deepEqual(cycleTaskIds, [idA, idB, idC].sort((a, b) => a - b));
    });

    it('detects direct mutual cycle A<->B', async () => {
      const idA = await createTask('A', 1);
      const idB = await createTask('B', 1);

      // A depends on B, B depends on A
      addDep(idA, idB);
      addDep(idB, idA);

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);
      const body = res.json();

      const tA = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idA}` })).json();
      const tB = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idB}` })).json();
      assert.equal(tA.status, 'cycle');
      assert.equal(tB.status, 'cycle');

      assert.equal(body.cycles.length, 1);
      const cycleTaskIds = body.cycles[0].taskIds.sort((a: number, b: number) => a - b);
      assert.deepEqual(cycleTaskIds, [idA, idB].sort((a, b) => a - b));
    });

    it('does not affect acyclic tasks when cycle exists', async () => {
      const idA = await createTask('A', 1);
      const idB = await createTask('B', 1);
      const idC = await createTask('C', 5);

      // A<->B cycle, C is independent
      addDep(idA, idB);
      addDep(idB, idA);

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);

      const tA = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idA}` })).json();
      const tB = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idB}` })).json();
      const tC = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idC}` })).json();
      assert.equal(tA.status, 'cycle');
      assert.equal(tB.status, 'cycle');
      assert.equal(tC.status, 'pending');
    });

    it('priority accumulation through chain', async () => {
      // Leaf (p=10, no deps) <- Middle (p=0, depends on Leaf) <- Root (p=0, depends on Middle)
      const idLeaf = await createTask('Leaf', 10);
      const idMiddle = await createTask('Middle', 0, [idLeaf]);
      const idRoot = await createTask('Root', 0, [idMiddle]);

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);

      const tLeaf = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idLeaf}` })).json();
      const tMiddle = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idMiddle}` })).json();
      const tRoot = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idRoot}` })).json();

      assert.equal(tLeaf.priority, 10);
      assert.equal(tMiddle.priority, 10); // 0 + 10 from Leaf
      assert.equal(tRoot.priority, 10);   // 0 + 10 from Middle
    });

    it('idempotent: calling twice returns same priorities', async () => {
      const idLeaf = await createTask('Leaf', 10);
      const idMiddle = await createTask('Middle', 0, [idLeaf]);
      const idRoot = await createTask('Root', 0, [idMiddle]);

      // First replan
      await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      const tLeaf1 = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idLeaf}` })).json();
      const tMiddle1 = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idMiddle}` })).json();
      const tRoot1 = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idRoot}` })).json();

      // Second replan
      await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      const tLeaf2 = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idLeaf}` })).json();
      const tMiddle2 = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idMiddle}` })).json();
      const tRoot2 = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idRoot}` })).json();

      assert.equal(tLeaf1.priority, tLeaf2.priority);
      assert.equal(tMiddle1.priority, tMiddle2.priority);
      assert.equal(tRoot1.priority, tRoot2.priority);
    });

    it('reset accepts cycle status', async () => {
      const idA = await createTask('A', 1);
      const idB = await createTask('B', 1);

      // Create mutual cycle
      addDep(idA, idB);
      addDep(idB, idA);

      await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });

      // Verify cycle status
      const tA = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idA}` })).json();
      assert.equal(tA.status, 'cycle');

      // Reset one of the cycle tasks
      const resetRes = await ctx.app.inject({ method: 'POST', url: `/tasks/${idA}/reset` });
      assert.equal(resetRes.statusCode, 200);
      assert.equal(resetRes.json().ok, true);

      const tAReset = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idA}` })).json();
      assert.equal(tAReset.status, 'pending');
    });

    it('task downstream of a cycle is not marked cycle', async () => {
      const idA = await createTask('A', 1);
      const idB = await createTask('B', 1, [idA]);
      const idC = await createTask('C', 1, [idA]); // C depends on A (downstream of cycle)

      // Create mutual cycle: A depends on B, B already depends on A
      addDep(idA, idB);

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);

      const tA = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idA}` })).json();
      const tB = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idB}` })).json();
      const tC = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idC}` })).json();

      assert.equal(tA.status, 'cycle', 'A should be in cycle');
      assert.equal(tB.status, 'cycle', 'B should be in cycle');
      assert.equal(tC.status, 'pending', 'C depends on a cycle member but is not itself cyclic');
    });

    it('claim-next skips cycle-status tasks', async () => {
      // Create a cycle pair
      const idA = await createTask('CycleA', 1);
      const idB = await createTask('CycleB', 1);
      addDep(idA, idB);
      addDep(idB, idA);

      // Create a clean pending task
      const idC = await createTask('CleanTask', 5);

      // Replan to mark A and B as cycle
      await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });

      // claim-next should return the clean task, not the cycle ones
      const claimRes = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claimRes.statusCode, 200);
      const body = claimRes.json();
      assert.ok(body.task, 'expected a task to be claimed');
      assert.equal(body.task.id, idC);
      assert.equal(body.task.title, 'CleanTask');
    });
  });
});
