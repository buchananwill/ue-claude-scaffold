import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestConfig, registerAgent } from '../test-helper.js';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import tasksPlugin from './tasks.js';
import agentsPlugin from './agents.js';

type TaskListBody = { tasks: Array<Record<string, unknown>>; total: number };

describe('tasks validation, pagination, and input guards', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    const config = createTestConfig();
    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(tasksPlugin, { config });
    await registerAgent(ctx.app, 'agent-1');
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  // ── Pagination edge cases ────────────────────────────────────────────

  describe('pagination', () => {
    it('default limit is 20', async () => {
      // Create 25 tasks
      for (let i = 0; i < 25; i++) {
        await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: `Task ${i + 1}` },
          headers: { 'x-project-id': 'default' },
        });
      }

      const res = await ctx.app.inject({ method: 'GET', url: '/tasks', headers: { 'x-project-id': 'default' } });
      assert.equal(res.statusCode, 200);
      const body = res.json() as TaskListBody;
      assert.equal(body.tasks.length, 20);
      assert.equal(body.total, 25);
    });

    it('offset beyond total returns empty tasks array', async () => {
      for (let i = 0; i < 3; i++) {
        await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: `Task ${i + 1}` },
          headers: { 'x-project-id': 'default' },
        });
      }

      const res = await ctx.app.inject({ method: 'GET', url: '/tasks?offset=100', headers: { 'x-project-id': 'default' } });
      assert.equal(res.statusCode, 200);
      const body = res.json() as TaskListBody;
      assert.equal(body.tasks.length, 0);
      assert.equal(body.total, 3);
    });

    it('negative offset is clamped to 0', async () => {
      await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'A' }, headers: { 'x-project-id': 'default' } });
      await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'B' }, headers: { 'x-project-id': 'default' } });

      const res = await ctx.app.inject({ method: 'GET', url: '/tasks?offset=-5', headers: { 'x-project-id': 'default' } });
      assert.equal(res.statusCode, 200);
      const body = res.json() as TaskListBody;
      assert.equal(body.tasks.length, 2);
      assert.equal(body.total, 2);
    });

    it('limit=0 is clamped to 1', async () => {
      await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'A' }, headers: { 'x-project-id': 'default' } });
      await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'B' }, headers: { 'x-project-id': 'default' } });

      const res = await ctx.app.inject({ method: 'GET', url: '/tasks?limit=0', headers: { 'x-project-id': 'default' } });
      assert.equal(res.statusCode, 200);
      const body = res.json() as TaskListBody;
      assert.equal(body.tasks.length, 1);
      assert.equal(body.total, 2);
    });

    it('status filter with pagination', async () => {
      // Create 3 pending tasks
      for (let i = 0; i < 3; i++) {
        await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: `Pending ${i + 1}` },
          headers: { 'x-project-id': 'default' },
        });
      }

      // Create 2 tasks and complete them
      for (let i = 0; i < 2; i++) {
        const r = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: `Completed ${i + 1}` },
          headers: { 'x-project-id': 'default' },
        });
        const id = r.json().id;
        await ctx.app.inject({
          method: 'POST',
          url: `/tasks/${id}/claim`,
          headers: { 'x-project-id': 'default', 'x-agent-name': 'agent-1' },
        });
        await ctx.app.inject({
          method: 'POST',
          url: `/tasks/${id}/complete`,
          payload: { result: { done: true } },
          headers: { 'x-project-id': 'default' },
        });
      }

      // First page of pending: limit=2, offset=0
      const page1 = await ctx.app.inject({
        method: 'GET',
        url: '/tasks?status=pending&limit=2&offset=0',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(page1.statusCode, 200);
      const body1 = page1.json() as TaskListBody;
      assert.equal(body1.tasks.length, 2);
      assert.equal(body1.total, 3);

      // Second page of pending: limit=2, offset=2
      const page2 = await ctx.app.inject({
        method: 'GET',
        url: '/tasks?status=pending&limit=2&offset=2',
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(page2.statusCode, 200);
      const body2 = page2.json() as TaskListBody;
      assert.equal(body2.tasks.length, 1);
      assert.equal(body2.total, 3);
    });
  });

  describe('x-agent-name validation', () => {
    it('POST /tasks/claim-next rejects malformed x-agent-name', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-project-id': 'default', 'x-agent-name': '../../evil' },
      });
      assert.equal(res.statusCode, 400);
      const body = res.json();
      assert.ok(body.message.includes('Invalid X-Agent-Name header format'));
    });

    it('POST /tasks/:id/claim rejects malformed x-agent-name', async () => {
      // Create a task first
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Agent name test task' },
        headers: { 'x-project-id': 'default' },
      });
      const taskId = createRes.json().id;

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-project-id': 'default', 'x-agent-name': '../../evil' },
      });
      assert.equal(res.statusCode, 400);
      const body = res.json();
      assert.ok(body.message.includes('Invalid X-Agent-Name header format'));
    });
  });

  describe('targetAgents validation', () => {
    it('POST /tasks rejects targetAgents with invalid agent names', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: {
          title: 'Target agents test',
          targetAgents: ['valid-agent', '../../evil'],
        },
        headers: { 'x-project-id': 'default' },
      });
      assert.equal(res.statusCode, 400);
      const body = res.json();
      assert.ok(body.message.includes('Invalid agent name in targetAgents'));
    });
  });
});
