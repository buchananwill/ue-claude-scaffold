import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import statusPlugin from './status.js';
import * as agentsQ from '../queries/agents.js';
import * as tasksCore from '../queries/tasks-core.js';
import * as msgQ from '../queries/messages.js';

describe('GET /status', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(statusPlugin);
  });

  afterEach(async () => {
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

    // Also add default-project data to ensure filtering works
    await agentsQ.register(db, {
      name: 'default-agent',
      worktree: '/tmp/wt-default',
      projectId: 'default',
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

  it('since=0 behaves the same as no since parameter (paging mode)', async () => {
    const db = ctx.db;

    await msgQ.insert(db, {
      fromAgent: 'zero-agent',
      channel: 'general',
      type: 'status_update',
      payload: { message: 'msg for since=0 test' },
    });

    const resNoSince = await ctx.app.inject({
      method: 'GET',
      url: '/status',
    });
    const resSince0 = await ctx.app.inject({
      method: 'GET',
      url: '/status?since=0',
    });

    assert.equal(resNoSince.statusCode, 200);
    assert.equal(resSince0.statusCode, 200);

    const bodyNoSince = resNoSince.json();
    const bodySince0 = resSince0.json();

    // Both should return messages (paging mode)
    assert.ok(bodyNoSince.messages.length > 0, 'no-since should have messages');
    assert.ok(bodySince0.messages.length > 0, 'since=0 should have messages');
  });

  it('returns 400 for invalid since parameter', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/status?since=abc',
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 for negative since parameter', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/status?since=-5',
    });
    assert.equal(res.statusCode, 400);
  });

  it('respects taskLimit parameter', async () => {
    const db = ctx.db;

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

  it('clamps taskLimit to upper bound of 200', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/status?taskLimit=999',
    });
    assert.equal(res.statusCode, 200);
    // We cannot directly observe the clamped value, but the request should succeed
    // and not attempt to fetch 999 rows uncapped
    assert.ok(res.json().tasks);
  });

  it('uses X-Project-Id header exclusively (no project query param)', async () => {
    const db = ctx.db;

    await agentsQ.register(db, {
      name: 'header-proj-agent',
      worktree: '/tmp/wt-hp',
      projectId: 'header-proj',
    });

    // Use header, not query param
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/status',
      headers: { 'x-project-id': 'header-proj' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.agents.some((a: { name: string }) => a.name === 'header-proj-agent'));
  });
});
