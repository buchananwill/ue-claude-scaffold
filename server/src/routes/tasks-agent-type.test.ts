import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestConfig } from '../test-helper.js';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import tasksPlugin from './tasks.js';
import agentsPlugin from './agents.js';

type TaskListBody = { tasks: Array<Record<string, unknown>>; total: number };

describe('tasks agentTypeOverride', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    const config = createTestConfig();
    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(tasksPlugin, { config });

    // Register agents used by claim tests in this block
    for (const name of ['agent-1']) {
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

  // ── agentTypeOverride ─────────────────────────────────────────────

  it('POST /tasks with agentTypeOverride persists the field', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Override task', agentTypeOverride: 'container-reviewer' },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 200);
    const { id } = res.json();

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}`, headers: { 'x-project-id': 'default' } });
    assert.equal(get.statusCode, 200);
    assert.equal(get.json().agentTypeOverride, 'container-reviewer');
  });

  it('POST /tasks without agentTypeOverride returns null', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'No override' },
      headers: { 'x-project-id': 'default' },
    });
    const { id } = res.json();

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}`, headers: { 'x-project-id': 'default' } });
    assert.equal(get.json().agentTypeOverride, null);
  });

  it('POST /tasks with invalid agentTypeOverride returns 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Bad override', agentTypeOverride: '../invalid-name!' },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('agentTypeOverride'));
  });

  it('PATCH /tasks/:id can update agentTypeOverride', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Patchable' },
      headers: { 'x-project-id': 'default' },
    });
    const { id } = post.json();

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { agentTypeOverride: 'container-implementer' },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(patch.statusCode, 200);

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}`, headers: { 'x-project-id': 'default' } });
    assert.equal(get.json().agentTypeOverride, 'container-implementer');
  });

  it('PATCH /tasks/:id can clear agentTypeOverride to null', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Has override', agentTypeOverride: 'container-reviewer' },
      headers: { 'x-project-id': 'default' },
    });
    const { id } = post.json();

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { agentTypeOverride: null },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(patch.statusCode, 200);

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}`, headers: { 'x-project-id': 'default' } });
    assert.equal(get.json().agentTypeOverride, null);
  });

  it('PATCH /tasks/:id rejects invalid agentTypeOverride', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Bad patch' },
      headers: { 'x-project-id': 'default' },
    });
    const { id } = post.json();

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { agentTypeOverride: 'has spaces and !special' },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(patch.statusCode, 400);
    assert.ok(patch.json().message.includes('agentTypeOverride'));
  });

  it('POST /tasks/batch with agentTypeOverride persists on each task', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/batch',
      payload: {
        tasks: [
          { title: 'Batch A', agentTypeOverride: 'container-reviewer' },
          { title: 'Batch B' },
          { title: 'Batch C', agentTypeOverride: 'container-implementer' },
        ],
      },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 200);
    const { ids } = res.json();

    const getA = await ctx.app.inject({ method: 'GET', url: `/tasks/${ids[0]}`, headers: { 'x-project-id': 'default' } });
    assert.equal(getA.json().agentTypeOverride, 'container-reviewer');

    const getB = await ctx.app.inject({ method: 'GET', url: `/tasks/${ids[1]}`, headers: { 'x-project-id': 'default' } });
    assert.equal(getB.json().agentTypeOverride, null);

    const getC = await ctx.app.inject({ method: 'GET', url: `/tasks/${ids[2]}`, headers: { 'x-project-id': 'default' } });
    assert.equal(getC.json().agentTypeOverride, 'container-implementer');
  });

  it('POST /tasks/batch rejects invalid agentTypeOverride', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/batch',
      payload: {
        tasks: [
          { title: 'Good task' },
          { title: 'Bad task', agentTypeOverride: '../bad!' },
        ],
      },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('Task 1'));
    assert.ok(res.json().message.includes('agentTypeOverride'));
  });

  it('GET /tasks includes agentTypeOverride in list response', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Listed task', agentTypeOverride: 'container-reviewer' },
      headers: { 'x-project-id': 'default' },
    });

    const list = await ctx.app.inject({ method: 'GET', url: '/tasks', headers: { 'x-project-id': 'default' } });
    assert.equal(list.statusCode, 200);
    const body = list.json() as TaskListBody;
    assert.equal(body.tasks[0].agentTypeOverride, 'container-reviewer');
  });

  it('POST /tasks rejects null agentTypeOverride with 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Null override', agentTypeOverride: null },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('agentTypeOverride must be a string or omitted, not null'));
  });

  it('POST /tasks/batch rejects null agentTypeOverride with 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/batch',
      payload: {
        tasks: [
          { title: 'Good task' },
          { title: 'Null override', agentTypeOverride: null },
        ],
      },
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('Task 1'));
    assert.ok(res.json().message.includes('agentTypeOverride must be a string or omitted, not null'));
  });

  // ── agentTypeOverride filter on GET /tasks ────────────────────────

  it('GET /tasks?agentTypeOverride=container-reviewer returns only matching tasks', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Reviewer task', agentTypeOverride: 'container-reviewer' }, headers: { 'x-project-id': 'default' } });
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Implementer task', agentTypeOverride: 'container-implementer' }, headers: { 'x-project-id': 'default' } });
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Default task' }, headers: { 'x-project-id': 'default' } });

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?agentTypeOverride=container-reviewer', headers: { 'x-project-id': 'default' } });
    assert.equal(res.statusCode, 200);
    const body = res.json() as TaskListBody;
    assert.equal(body.total, 1);
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].agentTypeOverride, 'container-reviewer');
  });

  it('GET /tasks?agentTypeOverride=__default__ returns tasks with null override', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Override task', agentTypeOverride: 'container-reviewer' }, headers: { 'x-project-id': 'default' } });
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Default task 1' }, headers: { 'x-project-id': 'default' } });
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Default task 2' }, headers: { 'x-project-id': 'default' } });

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?agentTypeOverride=__default__', headers: { 'x-project-id': 'default' } });
    assert.equal(res.statusCode, 200);
    const body = res.json() as TaskListBody;
    assert.equal(body.total, 2);
    for (const t of body.tasks) {
      assert.equal(t.agentTypeOverride, null);
    }
  });

  it('GET /tasks?agentTypeOverride=container-reviewer,__default__ returns both', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Reviewer task', agentTypeOverride: 'container-reviewer' }, headers: { 'x-project-id': 'default' } });
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Implementer task', agentTypeOverride: 'container-implementer' }, headers: { 'x-project-id': 'default' } });
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Default task' }, headers: { 'x-project-id': 'default' } });

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?agentTypeOverride=container-reviewer,__default__', headers: { 'x-project-id': 'default' } });
    assert.equal(res.statusCode, 200);
    const body = res.json() as TaskListBody;
    assert.equal(body.total, 2);
    const overrides = body.tasks.map((t: TaskListBody['tasks'][number]) => t.agentTypeOverride);
    assert.ok(overrides.includes('container-reviewer'));
    assert.ok(overrides.includes(null));
  });

  it('GET /tasks?agentTypeOverride=../invalid returns 400', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?agentTypeOverride=../invalid', headers: { 'x-project-id': 'default' } });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('Invalid agentTypeOverride value'));
  });

  it('GET /tasks?agentTypeOverride= with empty segments returns 400', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?agentTypeOverride=,container-reviewer', headers: { 'x-project-id': 'default' } });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('empty segments'));
  });
});
