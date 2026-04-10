import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestConfig } from '../test-helper.js';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import tasksPlugin from './tasks.js';
import agentsPlugin from './agents.js';

describe('tasks-claim routes', () => {
  let ctx: DrizzleTestContext;

  /** Register an agent by name so resolveAgent succeeds during claim routes. */
  async function registerAgent(name: string) {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name, worktree: `/tmp/${name}` },
    });
  }

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    const config = createTestConfig();
    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(tasksPlugin, { config });
    // Pre-register agents used across tests
    await registerAgent('agent-1');
    await registerAgent('agent-2');
    await registerAgent('agent-other');
    await registerAgent('agent-requester');
    await registerAgent('unknown');
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
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

    // Verify the task is now claimed (claimedBy is now a UUID, not a name)
    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.equal(task.status, 'claimed');
    assert.ok(task.claimedBy, 'claimedBy should be set');
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
    const blocker = (await ctx.app.inject({ method: 'GET', url: '/tasks' })).json().tasks[0];
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
    const first = (await ctx.app.inject({ method: 'GET', url: '/tasks' })).json().tasks[0];
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
    const blocker = (await ctx.app.inject({ method: 'GET', url: '/tasks' })).json().tasks[0];
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
    assert.ok(task.claimedBy, 'claimedBy should be set');

    // Verify via GET
    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${task.id}` });
    assert.equal(get.json().status, 'claimed');
    assert.ok(get.json().claimedBy, 'claimedBy should be set');
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
    assert.ok(body.task.claimedBy, 'claimedBy should be set');
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
    assert.ok(task.claimedBy, 'claimedBy should be set');
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
    const locker = (await ctx.app.inject({ method: 'GET', url: '/tasks' })).json().tasks[0];
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
    const first = (await ctx.app.inject({ method: 'GET', url: '/tasks' })).json().tasks[0];
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
