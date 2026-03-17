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
    assert.equal(agents[0].plan_doc, 'plan.md');
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
});
