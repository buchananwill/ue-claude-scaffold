import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, createTestConfig, type TestContext } from '../test-helper.js';
import agentsPlugin from './agents.js';
import messagesPlugin from './messages.js';
import tasksPlugin from './tasks.js';
import searchPlugin from './search.js';

describe('search routes', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
    const config = createTestConfig();
    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(messagesPlugin);
    await ctx.app.register(tasksPlugin, { config });
    await ctx.app.register(searchPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.cleanup();
  });

  it('returns 400 when q is missing', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/search' });
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 when q is 1 character', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/search?q=x' });
    assert.equal(res.statusCode, 400);
  });

  it('finds task by title substring', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Implement widget rendering' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/search?q=widget' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].title, 'Implement widget rendering');
  });

  it('finds task by description substring', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Some task', description: 'Refactor the collision subsystem' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/search?q=collision' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].title, 'Some task');
  });

  it('finds message by payload content', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      headers: { 'x-agent-name': 'agent-1' },
      payload: { channel: 'general', type: 'info', payload: { text: 'build succeeded perfectly' } },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/search?q=succeeded' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].channel, 'general');
  });

  it('finds agent by name', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'builder-alpha', worktree: '/tmp/wt1' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/search?q=builder-alpha' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.agents.length, 1);
    assert.equal(body.agents[0].name, 'builder-alpha');
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: `Searchable item ${i}` },
      });
    }

    const res = await ctx.app.inject({ method: 'GET', url: '/search?q=Searchable&limit=2' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.tasks.length, 2);
  });

  it('no cross-contamination: searching for a task title does not return unrelated messages', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Unique frobnicator task' },
    });

    await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      headers: { 'x-agent-name': 'agent-1' },
      payload: { channel: 'builds', type: 'info', payload: { text: 'completely unrelated content' } },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/search?q=frobnicator' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.tasks.length, 1);
    assert.equal(body.messages.length, 0);
    assert.equal(body.agents.length, 0);
  });
});
