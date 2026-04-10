import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import { tasks, messages, agents } from '../schema/tables.js';
import { v7 as uuidv7 } from 'uuid';
import searchPlugin from './search.js';

describe('search routes (drizzle)', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(searchPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
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
    await ctx.db.insert(tasks).values({
      title: 'Implement widget rendering',
      projectId: 'default',
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/search?q=widget' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].title, 'Implement widget rendering');
  });

  it('finds task by description substring', async () => {
    await ctx.db.insert(tasks).values({
      title: 'Some task',
      description: 'Refactor the collision subsystem',
      projectId: 'default',
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/search?q=collision' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].title, 'Some task');
  });

  it('finds message by payload content', async () => {
    await ctx.db.insert(messages).values({
      fromAgent: 'agent-1',
      channel: 'general',
      type: 'info',
      payload: { text: 'build succeeded perfectly' },
      projectId: 'default',
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/search?q=succeeded' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].channel, 'general');
  });

  it('finds agent by name', async () => {
    await ctx.db.insert(agents).values({
      id: uuidv7(),
      name: 'builder-alpha',
      worktree: '/tmp/wt1',
      projectId: 'default',
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/search?q=builder-alpha' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.agents.length, 1);
    assert.equal(body.agents[0].name, 'builder-alpha');
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.db.insert(tasks).values({
        title: `Searchable item ${i}`,
        projectId: 'default',
      });
    }

    const res = await ctx.app.inject({ method: 'GET', url: '/search?q=Searchable&limit=2' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.tasks.length, 2);
  });

  it('no cross-contamination: searching for a task title does not return unrelated messages', async () => {
    await ctx.db.insert(tasks).values({
      title: 'Unique frobnicator task',
      projectId: 'default',
    });

    await ctx.db.insert(messages).values({
      fromAgent: 'agent-1',
      channel: 'builds',
      type: 'info',
      payload: { text: 'completely unrelated content' },
      projectId: 'default',
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/search?q=frobnicator' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.tasks.length, 1);
    assert.equal(body.messages.length, 0);
    assert.equal(body.agents.length, 0);
  });
});
