import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import statusPlugin from './status.js';
import * as agentsQ from '../queries/agents.js';
import * as tasksCore from '../queries/tasks-core.js';
import * as msgQ from '../queries/messages.js';

describe('GET /status', () => {
  let ctx: DrizzleTestContext;

  before(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(statusPlugin);
  });

  after(async () => {
    await ctx?.app.close();
    await ctx?.cleanup();
  });

  it('returns correct shape with empty state', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.agents));
    assert.equal(body.agents.length, 0);
    assert.ok(body.tasks);
    assert.ok(Array.isArray(body.tasks.items));
    assert.equal(body.tasks.items.length, 0);
    assert.equal(body.tasks.total, 0);
    assert.ok(Array.isArray(body.messages));
    assert.equal(body.messages.length, 0);
  });

  it('returns agents, tasks, and messages when populated', async () => {
    const db = ctx.db;

    await agentsQ.register(db, {
      name: 'status-agent-1',
      worktree: '/tmp/wt1',
      projectId: 'default',
    });

    await tasksCore.insert(db, {
      title: 'Test task',
      description: 'A task for status test',
      priority: 5,
      projectId: 'default',
    });

    await msgQ.insert(db, {
      fromAgent: 'status-agent-1',
      channel: 'general',
      type: 'status_update',
      payload: { message: 'hello' },
      projectId: 'default',
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    assert.equal(body.agents.length, 1);
    assert.equal(body.agents[0].name, 'status-agent-1');

    assert.equal(body.tasks.items.length, 1);
    assert.equal(body.tasks.items[0].title, 'Test task');
    assert.equal(body.tasks.total, 1);

    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].type, 'status_update');
  });

  it('filters by project when X-Project-Id header is set', async () => {
    const db = ctx.db;

    // Create data for a specific project
    await agentsQ.register(db, {
      name: 'proj-agent',
      worktree: '/tmp/wt-proj',
      projectId: 'my-proj',
    });

    await tasksCore.insert(db, {
      title: 'Project-scoped task',
      projectId: 'my-proj',
    });

    await msgQ.insert(db, {
      fromAgent: 'proj-agent',
      channel: 'general',
      type: 'status_update',
      payload: { message: 'project msg' },
      projectId: 'my-proj',
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/status',
      headers: { 'x-project-id': 'my-proj' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    // Should only include my-proj data
    assert.ok(body.agents.every((a: { projectId: string }) => a.projectId === 'my-proj'));
    assert.ok(body.tasks.items.every((t: { projectId: string }) => t.projectId === 'my-proj'));
    assert.ok(body.messages.every((m: { fromAgent: string }) => m.fromAgent === 'proj-agent'));
  });

  it('respects since parameter for messages', async () => {
    const db = ctx.db;

    // Insert a couple messages to general
    const id1 = await msgQ.insert(db, {
      fromAgent: 'since-agent',
      channel: 'general',
      type: 'status_update',
      payload: { message: 'msg 1' },
    });

    const id2 = await msgQ.insert(db, {
      fromAgent: 'since-agent',
      channel: 'general',
      type: 'status_update',
      payload: { message: 'msg 2' },
    });

    // Use since=id1 to only get msg 2
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/status?since=${id1}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    // Should include id2 but not id1
    const msgIds = body.messages.map((m: { id: number }) => m.id);
    assert.ok(!msgIds.includes(id1), 'should not include id1');
    assert.ok(msgIds.includes(id2), 'should include id2');
  });

  it('respects taskLimit parameter', async () => {
    const db = ctx.db;

    // Insert extra tasks
    for (let i = 0; i < 5; i++) {
      await tasksCore.insert(db, {
        title: `Limit task ${i}`,
        projectId: 'limit-proj',
      });
    }

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/status?taskLimit=2',
      headers: { 'x-project-id': 'limit-proj' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.tasks.items.length, 2);
    assert.equal(body.tasks.total, 5);
  });

  it('accepts project query param as alternative to header', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/status?project=my-proj',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    // proj-agent was registered under my-proj earlier
    assert.ok(body.agents.some((a: { name: string }) => a.name === 'proj-agent'));
  });
});
