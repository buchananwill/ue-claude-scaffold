import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestConfig } from '../test-helper.js';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import tasksPlugin from './tasks.js';
import agentsPlugin from './agents.js';

type TaskListBody = { tasks: Array<Record<string, unknown>>; total: number };

describe('tasks routes', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    const config = createTestConfig();
    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(tasksPlugin, { config });

    // Register agents used by claim tests in this block
    for (const name of ['agent-1', 'agent-lock', 'agent-resolver']) {
      await ctx.app.inject({
        method: 'POST',
        url: '/agents/register',
        headers: { 'x-project-id': 'default' },
        payload: { name, worktree: `/tmp/${name}` },
      });
    }
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it('POST /tasks creates a task and returns id', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Build widget', description: 'Create the widget system' },
      headers: { 'x-project-id': 'default' },
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
      headers: { 'x-project-id': 'default' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Task B' },
      headers: { 'x-project-id': 'default' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks', headers: { 'x-project-id': 'default' }});
    assert.equal(res.statusCode, 200);
    const body = res.json() as TaskListBody;
    const tasks = body.tasks;
    assert.equal(body.total, 2);
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
      headers: { 'x-project-id': 'default' },
    });
    const r2 = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Claimed task' },
      headers: { 'x-project-id': 'default' },
    });
    const claimedId = r2.json().id;

    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${claimedId}/claim`,
      headers: { 'x-project-id': 'default', 'x-agent-name': 'agent-1' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?status=pending', headers: { 'x-project-id': 'default' }});
    assert.equal(res.statusCode, 200);
    const body = res.json() as TaskListBody;
    const tasks = body.tasks;
    assert.equal(body.total, 1);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, 'Pending task');
    assert.equal(tasks[0].status, 'pending');
  });

  it('GET /tasks supports limit and offset pagination', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'T1' }, headers: { 'x-project-id': 'default' }});
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'T2' }, headers: { 'x-project-id': 'default' }});
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'T3' }, headers: { 'x-project-id': 'default' }});

    const page1 = await ctx.app.inject({ method: 'GET', url: '/tasks?limit=2&offset=0', headers: { 'x-project-id': 'default' }});
    const body1 = page1.json() as TaskListBody;
    assert.equal(body1.tasks.length, 2);
    assert.equal(body1.total, 3);

    const page2 = await ctx.app.inject({ method: 'GET', url: '/tasks?limit=2&offset=2', headers: { 'x-project-id': 'default' } });
    const body2 = page2.json() as TaskListBody;
    assert.equal(body2.tasks.length, 1);
    assert.equal(body2.total, 3);
  });

  it('GET /tasks with multi-status filter', async () => {
    // Create tasks, then manually change one status via direct claim
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Pending1' }, headers: { 'x-project-id': 'default' }});
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Pending2' }, headers: { 'x-project-id': 'default' }});

    // Get all with status=pending
    const res1 = await ctx.app.inject({ method: 'GET', url: '/tasks?status=pending', headers: { 'x-project-id': 'default' }});
    const body1 = res1.json() as TaskListBody;
    assert.equal(body1.tasks.length, 2);
    assert.equal(body1.total, 2);

    // Multi-status: pending,completed (only pending exist)
    const res2 = await ctx.app.inject({ method: 'GET', url: '/tasks?status=pending,completed', headers: { 'x-project-id': 'default' } });
    const body2 = res2.json() as TaskListBody;
    assert.equal(body2.tasks.length, 2);
    assert.equal(body2.total, 2);
  });

  it('GET /tasks with priority filter', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'P0', priority: 0 }, headers: { 'x-project-id': 'default' }});
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'P1', priority: 1 }, headers: { 'x-project-id': 'default' }});
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'P2', priority: 2 }, headers: { 'x-project-id': 'default' }});

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?priority=0,2', headers: { 'x-project-id': 'default' }});
    const body = res.json() as TaskListBody;
    assert.equal(body.tasks.length, 2);
    assert.equal(body.total, 2);
    const priorities = body.tasks.map((t: Record<string, unknown>) => t.priority);
    assert.ok(priorities.includes(0));
    assert.ok(priorities.includes(2));
  });

  it('GET /tasks with sort and dir', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'AAA', priority: 1 }, headers: { 'x-project-id': 'default' }});
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'ZZZ', priority: 2 }, headers: { 'x-project-id': 'default' }});
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'MMM', priority: 0 }, headers: { 'x-project-id': 'default' }});

    // Sort by title ascending
    const res1 = await ctx.app.inject({ method: 'GET', url: '/tasks?sort=title&dir=asc', headers: { 'x-project-id': 'default' }});
    const body1 = res1.json() as TaskListBody;
    assert.equal(body1.tasks[0].title, 'AAA');
    assert.equal(body1.tasks[1].title, 'MMM');
    assert.equal(body1.tasks[2].title, 'ZZZ');

    // Sort by title descending
    const res2 = await ctx.app.inject({ method: 'GET', url: '/tasks?sort=title&dir=desc', headers: { 'x-project-id': 'default' } });
    const body2 = res2.json() as TaskListBody;
    assert.equal(body2.tasks[0].title, 'ZZZ');
    assert.equal(body2.tasks[2].title, 'AAA');
  });

  it('GET /tasks with invalid sort column returns 400', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?sort=bogus', headers: { 'x-project-id': 'default' }});
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.ok(body.message.includes('Invalid sort column'));
  });

  it('GET /tasks with invalid dir returns 400', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?sort=title&dir=sideways', headers: { 'x-project-id': 'default' }});
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.ok(body.message.includes('Invalid dir'));
  });

  it('GET /tasks with agent filter', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Unassigned1' }, headers: { 'x-project-id': 'default' }});
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Unassigned2' }, headers: { 'x-project-id': 'default' }});

    // Filter by __unassigned__ (both tasks have null claimedBy)
    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?agent=__unassigned__', headers: { 'x-project-id': 'default' }});
    const body = res.json() as TaskListBody;
    assert.equal(body.tasks.length, 2);
    assert.equal(body.total, 2);
  });

  it('GET /tasks priority filter returns 400 for non-numeric values', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'P0', priority: 0 }, headers: { 'x-project-id': 'default' }});

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?priority=0,abc', headers: { 'x-project-id': 'default' }});
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('Invalid priority'));
  });

  it('GET /tasks priority filter returns 400 for trailing comma (empty segment)', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'P0', priority: 0 }, headers: { 'x-project-id': 'default' }});

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?priority=0,', headers: { 'x-project-id': 'default' }});
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('empty segments'));
  });

  it('GET /tasks priority filter returns 400 for leading comma (empty segment)', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'P1', priority: 1 }, headers: { 'x-project-id': 'default' }});

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?priority=,1', headers: { 'x-project-id': 'default' }});
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('empty segments'));
  });

  it('GET /tasks with dir but no sort returns 400', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?dir=asc', headers: { 'x-project-id': 'default' }});
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('dir requires sort'));
  });

  it('GET /tasks with sort but no dir defaults to ascending', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'ZZZ' }, headers: { 'x-project-id': 'default' }});
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'AAA' }, headers: { 'x-project-id': 'default' }});
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'MMM' }, headers: { 'x-project-id': 'default' }});

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?sort=title', headers: { 'x-project-id': 'default' }});
    assert.equal(res.statusCode, 200);
    const body = res.json() as TaskListBody;
    assert.equal(body.tasks[0].title, 'AAA');
    assert.equal(body.tasks[1].title, 'MMM');
    assert.equal(body.tasks[2].title, 'ZZZ');
  });

  it('GET /tasks with invalid status returns 400', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?status=bogus', headers: { 'x-project-id': 'default' }});
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('Invalid status value'));
  });

  it('GET /tasks status filter returns 400 for empty segments', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?status=pending,', headers: { 'x-project-id': 'default' }});
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('empty segments'));
  });

  it('GET /tasks agent filter returns 400 for empty segments', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?agent=,agent-1', headers: { 'x-project-id': 'default' }});
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('empty segments'));
  });

  it('GET /tasks agent filter returns 400 for invalid agent name', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?agent=../bad', headers: { 'x-project-id': 'default' }});
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('Invalid agent name'));
  });

  it('GET /tasks returns 400 when status filter exceeds 50 values', async () => {
    const statuses = Array.from({ length: 51 }, () => 'pending').join(',');
    const res = await ctx.app.inject({ method: 'GET', url: `/tasks?status=${statuses}` , headers: { 'x-project-id': 'default' }});
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('Too many'));
  });

  it('GET /tasks returns 400 when agent filter exceeds 50 values', async () => {
    const agents = Array.from({ length: 51 }, (_, i) => `agent-${i}`).join(',');
    const res = await ctx.app.inject({ method: 'GET', url: `/tasks?agent=${agents}` , headers: { 'x-project-id': 'default' }});
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('Too many'));
  });

  it('GET /tasks returns 400 when priority filter exceeds 50 values', async () => {
    const priorities = Array.from({ length: 51 }, (_, i) => String(i)).join(',');
    const res = await ctx.app.inject({ method: 'GET', url: `/tasks?priority=${priorities}` , headers: { 'x-project-id': 'default' }});
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('Too many'));
  });

  it('GET /tasks filtered total matches filtered count, not global count', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'P0', priority: 0 }, headers: { 'x-project-id': 'default' }});
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'P1', priority: 1 }, headers: { 'x-project-id': 'default' }});
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'P2', priority: 2 }, headers: { 'x-project-id': 'default' }});

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?priority=1', headers: { 'x-project-id': 'default' }});
    const body = res.json() as TaskListBody;
    assert.equal(body.tasks.length, 1);
    assert.equal(body.total, 1); // not 3!
  });

  it('GET /tasks/:id returns a single task', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'My task', description: 'Details here', priority: 5 },
      headers: { 'x-project-id': 'default' },
    });
    const id = post.json().id;

    const res = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` , headers: { 'x-project-id': 'default' }});
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
    const res = await ctx.app.inject({ method: 'GET', url: '/tasks/99999', headers: { 'x-project-id': 'default' }});
    assert.equal(res.statusCode, 404);
  });

  // ── PATCH /tasks/:id ─────────────────────────────────────────────────

  it('PATCH /tasks/:id updates title of a pending task', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Original title' },
      headers: { 'x-project-id': 'default' },
    });
    const id = post.json().id;

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { title: 'Updated title' },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(patch.statusCode, 200);
    assert.deepEqual(patch.json(), { ok: true });

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` , headers: { 'x-project-id': 'default' }});
    const task = get.json();
    assert.equal(task.title, 'Updated title');
  });

  it('PATCH /tasks/:id partial update only touches provided fields', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Keep me', description: 'Original desc', priority: 3 },
      headers: { 'x-project-id': 'default' },
    });
    const id = post.json().id;

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { priority: 10 },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(patch.statusCode, 200);

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` , headers: { 'x-project-id': 'default' }});
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
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(patch.statusCode, 404);
  });

  it('PATCH /tasks/:id returns 409 when task is claimed', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Will be claimed' },
      headers: { 'x-project-id': 'default' },
    });
    const id = post.json().id;

    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-project-id': 'default', 'x-agent-name': 'agent-1' },
    });

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { title: 'Too late' },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(patch.statusCode, 409);
  });

  it('PATCH /tasks/:id returns 409 when task is completed', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Will be completed' },
      headers: { 'x-project-id': 'default' },
    });
    const id = post.json().id;

    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-project-id': 'default', 'x-agent-name': 'agent-1' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/complete`,
      payload: { result: { summary: 'Done' } },
      headers: { 'x-project-id': 'default' },
    });

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { title: 'Too late' },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(patch.statusCode, 409);
  });

  it('PATCH /tasks/:id returns 400 when body has no updatable fields', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Untouched' },
      headers: { 'x-project-id': 'default' },
    });
    const id = post.json().id;

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { bogus: 'field' },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(patch.statusCode, 400);
  });

  it('PATCH /tasks/:id allows clearing sourcePath to null', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Has no source' },
      headers: { 'x-project-id': 'default' },
    });
    const id = post.json().id;

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { sourcePath: null },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(patch.statusCode, 200);
    assert.deepEqual(patch.json(), { ok: true });

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` , headers: { 'x-project-id': 'default' }});
    assert.equal(get.json().sourcePath, null);
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
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 200);
    const { id } = res.json();

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` , headers: { 'x-project-id': 'default' }});
    const task = get.json();
    assert.deepEqual(task.files, ['Source/Foo.cpp', 'Source/Foo.h']);
  });

  it('POST /tasks without files returns files as empty array', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'No files' },
      headers: { 'x-project-id': 'default' },
    });
    const { id } = res.json();

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` , headers: { 'x-project-id': 'default' }});
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
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 400, `Expected 400 for ${label} path`);
    }
  });

  it('GET /tasks/:id returns files array', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Files test', files: ['A.cpp', 'B.h'] },
      headers: { 'x-project-id': 'default' },
    });
    const { id } = post.json();

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` , headers: { 'x-project-id': 'default' }});
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
      headers: { 'x-project-id': 'default' },
    });
    const { id } = post.json();

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { files: ['New.cpp', 'New.h'] },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(patch.statusCode, 200);

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` , headers: { 'x-project-id': 'default' }});
    const task = get.json();
    assert.deepEqual(task.files.sort(), ['New.cpp', 'New.h']);
  });

  it('DELETE /tasks/:id cascades to task_files', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Delete me', files: ['Doomed.cpp'] },
      headers: { 'x-project-id': 'default' },
    });
    const { id } = post.json();

    const del = await ctx.app.inject({ method: 'DELETE', url: `/tasks/${id}` , headers: { 'x-project-id': 'default' }});
    assert.equal(del.statusCode, 200);

    // Task gone
    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` , headers: { 'x-project-id': 'default' }});
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
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.ids.length, 3);

    // Verify files on each task
    const get1 = await ctx.app.inject({ method: 'GET', url: `/tasks/${body.ids[0]}` , headers: { 'x-project-id': 'default' }});
    assert.deepEqual(get1.json().files, ['Shared.cpp']);

    const get2 = await ctx.app.inject({ method: 'GET', url: `/tasks/${body.ids[1]}` , headers: { 'x-project-id': 'default' }});
    assert.deepEqual(get2.json().files.sort(), ['Only2.h', 'Shared.cpp']);

    const get3 = await ctx.app.inject({ method: 'GET', url: `/tasks/${body.ids[2]}` , headers: { 'x-project-id': 'default' }});
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
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 400);

    // No tasks should have been created
    const list = await ctx.app.inject({ method: 'GET', url: '/tasks', headers: { 'x-project-id': 'default' }});
    assert.equal((list.json() as TaskListBody).tasks.length, 0);
  });

  it('batch with ?replan=true returns replan summary', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/batch?replan=true',
      payload: {
        tasks: [
          { title: 'Root', priority: 10 },
          { title: 'Middle', priority: 0, dependsOnIndex: [0] },
          { title: 'Leaf', priority: 0, dependsOnIndex: [1] },
        ],
      },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.ids.length, 3);

    // replan summary must be present
    assert.ok(body.replan, 'expected replan key in response');
    assert.equal(body.replan.ok, true);
    assert.ok(body.replan.replanned >= 3, `expected replanned >= 3, got ${body.replan.replanned}`);
    assert.ok(Array.isArray(body.replan.cycles));
    assert.equal(body.replan.cycles.length, 0);

    // The root task's priority should have been recomputed by replan
    const rootTask = await ctx.app.inject({ method: 'GET', url: `/tasks/${body.ids[0]}` , headers: { 'x-project-id': 'default' }});
    assert.equal(rootTask.statusCode, 200);
    // Priority was recomputed — just verify it's a number (replan may adjust it)
    assert.equal(typeof rootTask.json().priority, 'number');
  });

  it('batch without ?replan=true has no replan key', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/batch',
      payload: {
        tasks: [
          { title: 'Solo task' },
        ],
      },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.replan, undefined);
  });

  it('POST /tasks rejects unknown fields with 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Test', source_path: 'snake_case_mistake' },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('source_path'));
  });

  it('PATCH /tasks/:id rejects unknown fields with 400', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Test' },
      headers: { 'x-project-id': 'default' },
    });
    const { id } = post.json();

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { source_path: 'oops' },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(patch.statusCode, 400);
    assert.ok(patch.json().message.includes('source_path'));
  });

  describe('DELETE /tasks bulk-delete by status', () => {
    it('deletes completed tasks and returns count', async () => {
      const r1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Done 1' },
        headers: { 'x-project-id': 'default' },
      });
      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Done 2' },
        headers: { 'x-project-id': 'default' },
      });
      // Also insert a pending task that should NOT be deleted
      await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Still pending' },
        headers: { 'x-project-id': 'default' },
      });

      // Move two tasks to completed status via claim+complete lifecycle
      const id1 = r1.json().id;
      const id2 = r2.json().id;
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${id1}/claim`,
        headers: { 'x-project-id': 'default', 'x-agent-name': 'agent-1' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${id1}/complete`,
        headers: { 'x-project-id': 'default', 'x-agent-name': 'agent-1' },
        payload: { result: { summary: 'done' } },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${id2}/claim`,
        headers: { 'x-project-id': 'default', 'x-agent-name': 'agent-1' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${id2}/complete`,
        headers: { 'x-project-id': 'default', 'x-agent-name': 'agent-1' },
        payload: { result: { summary: 'done' } },
      });

      const res = await ctx.app.inject({
        method: 'DELETE',
        url: '/tasks?status=completed',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.ok, true);
      assert.equal(body.deleted, 2);

      // Verify the pending task still exists
      const listRes = await ctx.app.inject({ method: 'GET', url: '/tasks', headers: { 'x-project-id': 'default' }});
      const listBody = listRes.json() as TaskListBody;
      assert.equal(listBody.total, 1);
      assert.equal(listBody.tasks[0].title, 'Still pending');
    });

    it('returns 400 for invalid status value', async () => {
      const res = await ctx.app.inject({
        method: 'DELETE',
        url: '/tasks?status=bogus',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 400);
      const body = res.json();
      assert.ok(body.message.includes('Invalid status value'));
    });

    it('returns 400 when status query param is missing', async () => {
      const res = await ctx.app.inject({
        method: 'DELETE',
        url: '/tasks',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 400);
      const body = res.json();
      assert.ok(body.message.includes('status query parameter is required'));
    });

    it('returns 409 for claimed status (protected)', async () => {
      const res = await ctx.app.inject({
        method: 'DELETE',
        url: '/tasks?status=claimed',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 409);
      const body = res.json();
      assert.ok(body.message.includes('cannot bulk-delete'));
    });

    it('returns 409 for in_progress status (protected)', async () => {
      const res = await ctx.app.inject({ method: 'DELETE', url: '/tasks?status=in_progress', headers: { 'x-project-id': 'test' } });
      assert.equal(res.statusCode, 409);
    });

    it('scopes deletion to the requesting project', async () => {
      // Register agent-1 in both projects so claim calls succeed
      await ctx.app.inject({
        method: 'POST',
        url: '/agents/register',
        headers: { 'x-project-id': 'alpha' },
        payload: { name: 'agent-1', worktree: '/tmp/agent-1' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: '/agents/register',
        headers: { 'x-project-id': 'beta' },
        payload: { name: 'agent-1', worktree: '/tmp/agent-1' },
      });

      // Insert a task in project "alpha"
      await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        headers: { 'x-project-id': 'alpha' },
        payload: { title: 'Alpha completed' },
      });
      // Insert a task in project "beta"
      await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        headers: { 'x-project-id': 'beta' },
        payload: { title: 'Beta completed' },
      });

      // Claim and complete both tasks
      const alphaList = await ctx.app.inject({
        method: 'GET',
        url: '/tasks',
        headers: { 'x-project-id': 'alpha' },
      });
      const alphaId = (alphaList.json() as TaskListBody).tasks[0].id;
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${alphaId}/claim`,
        headers: { 'x-agent-name': 'agent-1', 'x-project-id': 'alpha' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${alphaId}/complete`,
        headers: { 'x-agent-name': 'agent-1', 'x-project-id': 'alpha' },
        payload: { result: { summary: 'done' } },
      });

      const betaList = await ctx.app.inject({
        method: 'GET',
        url: '/tasks',
        headers: { 'x-project-id': 'beta' },
      });
      const betaId = (betaList.json() as TaskListBody).tasks[0].id;
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${betaId}/claim`,
        headers: { 'x-agent-name': 'agent-1', 'x-project-id': 'beta' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${betaId}/complete`,
        headers: { 'x-agent-name': 'agent-1', 'x-project-id': 'beta' },
        payload: { result: { summary: 'done' } },
      });

      // Delete completed tasks scoped to "alpha" only
      const res = await ctx.app.inject({
        method: 'DELETE',
        url: '/tasks?status=completed',
        headers: { 'x-project-id': 'alpha' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().deleted, 1);

      // Beta's completed task should still exist
      const betaAfter = await ctx.app.inject({
        method: 'GET',
        url: '/tasks?status=completed',
        headers: { 'x-project-id': 'beta' },
      });
      assert.equal((betaAfter.json() as TaskListBody).total, 1);
    });
  });

});
