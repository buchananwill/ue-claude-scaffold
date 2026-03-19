import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestContext } from '../test-helper.js';
import agentsPlugin from './agents.js';

describe('agents routes', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
    await ctx.app.register(agentsPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.cleanup();
  });

  it('GET /agents returns empty array initially', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/agents' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  });

  it('POST /agents/register creates an agent, GET /agents returns it', async () => {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt1', planDoc: 'plan.md' },
    });
    assert.equal(reg.statusCode, 200);
    assert.deepEqual(reg.json(), { ok: true });

    const list = await ctx.app.inject({ method: 'GET', url: '/agents' });
    const agents = list.json();
    assert.equal(agents.length, 1);
    assert.equal(agents[0].name, 'agent-1');
    assert.equal(agents[0].worktree, '/tmp/wt1');
    assert.equal(agents[0].planDoc, 'plan.md');
    assert.equal(agents[0].status, 'idle');
  });

  it('POST /agents/register with same name is an upsert', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt2' },
    });

    const list = await ctx.app.inject({ method: 'GET', url: '/agents' });
    const agents = list.json();
    assert.equal(agents.length, 1);
    assert.equal(agents[0].worktree, '/tmp/wt2');
  });

  it('POST /agents/:name/status updates status', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/agent-1/status',
      payload: { status: 'building' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });

    const list = await ctx.app.inject({ method: 'GET', url: '/agents' });
    assert.equal(list.json()[0].status, 'building');
  });

  it('POST /agents/:name/status for non-existent agent returns 404', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/no-such-agent/status',
      payload: { status: 'building' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('GET /agents/:name returns a single agent', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt1', planDoc: 'plan.md' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/agents/agent-1' });
    assert.equal(res.statusCode, 200);
    const agent = res.json();
    assert.equal(agent.name, 'agent-1');
    assert.equal(agent.worktree, '/tmp/wt1');
    assert.equal(agent.planDoc, 'plan.md');
    assert.equal(agent.status, 'idle');
    assert.ok(agent.registeredAt);
  });

  it('GET /agents/:name returns 404 for nonexistent agent', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/agents/nonexistent' });
    assert.equal(res.statusCode, 404);
  });

  it('DELETE /agents/:name deregisters an agent', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    const del = await ctx.app.inject({ method: 'DELETE', url: '/agents/agent-1' });
    assert.equal(del.statusCode, 200);
    assert.deepEqual(del.json(), { ok: true });

    const list = await ctx.app.inject({ method: 'GET', url: '/agents' });
    assert.deepEqual(list.json(), []);
  });

  it('DELETE /agents/:name returns 404 for unknown agent', async () => {
    const del = await ctx.app.inject({ method: 'DELETE', url: '/agents/ghost' });
    assert.equal(del.statusCode, 404);
  });

  it('DELETE /agents deregisters all agents', async () => {
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

    const del = await ctx.app.inject({ method: 'DELETE', url: '/agents' });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().ok, true);
    assert.equal(del.json().removed, 2);

    const list = await ctx.app.inject({ method: 'GET', url: '/agents' });
    assert.deepEqual(list.json(), []);
  });
});
