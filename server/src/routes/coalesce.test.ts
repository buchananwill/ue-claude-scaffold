import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, createTestConfig, type TestContext } from '../test-helper.js';
import agentsPlugin from './agents.js';
import tasksPlugin from './tasks.js';
import filesPlugin from './files.js';
import coalescePlugin from './coalesce.js';

describe('coalesce routes', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
    const config = createTestConfig();
    await ctx.app.register(agentsPlugin);
    await ctx.app.register(tasksPlugin, { config });
    await ctx.app.register(filesPlugin);
    await ctx.app.register(coalescePlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.cleanup();
  });

  async function registerAgent(name: string, mode: string = 'pump') {
    return ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name, worktree: `/tmp/${name}`, mode },
    });
  }

  async function createTask(title: string, files?: string[]) {
    const payload: Record<string, unknown> = { title };
    if (files) payload.files = files;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload,
    });
    return res.json().id as number;
  }

  async function claimTask(id: number, agent: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-agent-name': agent },
    });
  }

  it('canCoalesce true when all agents idle and no active tasks', async () => {
    await registerAgent('pump-1');
    await registerAgent('pump-2');
    await createTask('Pending task 1');
    await createTask('Pending task 2');

    const res = await ctx.app.inject({ method: 'GET', url: '/coalesce/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.canCoalesce, true);
    assert.equal(body.pendingTasks, 2);
  });

  it('canCoalesce false when tasks in progress', async () => {
    await registerAgent('pump-1');
    const taskId = await createTask('Active task');
    await claimTask(taskId, 'pump-1');

    const res = await ctx.app.inject({ method: 'GET', url: '/coalesce/status' });
    const body = res.json();
    assert.equal(body.canCoalesce, false);
    assert.ok(body.reason.includes('task'));
  });

  it('canCoalesce false when pump agent not idle/done/paused', async () => {
    await registerAgent('pump-1');
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/pump-1/status',
      payload: { status: 'working' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/coalesce/status' });
    const body = res.json();
    assert.equal(body.canCoalesce, false);
    assert.ok(body.reason.includes('pump-1'));
  });

  it('POST /coalesce/pause sets pump agents to paused', async () => {
    await registerAgent('pump-1');
    await registerAgent('pump-2');

    const res = await ctx.app.inject({ method: 'POST', url: '/coalesce/pause' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.paused.includes('pump-1'));
    assert.ok(body.paused.includes('pump-2'));
    assert.deepEqual(body.inFlightTasks, []);

    const a1 = await ctx.app.inject({ method: 'GET', url: '/agents/pump-1' });
    assert.equal(a1.json().status, 'paused');
    const a2 = await ctx.app.inject({ method: 'GET', url: '/agents/pump-2' });
    assert.equal(a2.json().status, 'paused');
  });

  it('POST /coalesce/pause returns in-flight tasks', async () => {
    await registerAgent('pump-1');
    const taskId = await createTask('In-flight task');
    await claimTask(taskId, 'pump-1');

    const res = await ctx.app.inject({ method: 'POST', url: '/coalesce/pause' });
    const body = res.json();
    assert.equal(body.inFlightTasks.length, 1);
    assert.equal(body.inFlightTasks[0].agent, 'pump-1');
    assert.equal(body.inFlightTasks[0].taskId, taskId);
    assert.equal(body.inFlightTasks[0].title, 'In-flight task');
  });

  it('POST /coalesce/release clears ownership and resumes agents', async () => {
    await registerAgent('pump-1');
    const taskId = await createTask('Task with files', ['Source/A.cpp', 'Source/B.cpp']);
    await claimTask(taskId, 'pump-1');

    // Pause the agent first
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/pump-1/status',
      payload: { status: 'paused' },
    });

    const res = await ctx.app.inject({ method: 'POST', url: '/coalesce/release' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.releasedFiles, 2);
    assert.ok(body.resumedAgents.includes('pump-1'));

    // Verify files are cleared
    const filesRes = await ctx.app.inject({ method: 'GET', url: '/files?claimant=pump-1' });
    assert.equal(filesRes.json().length, 0);

    // Verify agent is idle
    const agentRes = await ctx.app.inject({ method: 'GET', url: '/agents/pump-1' });
    assert.equal(agentRes.json().status, 'idle');
  });

  it('after release, blocked tasks become claimable', async () => {
    await registerAgent('pump-1');
    await registerAgent('pump-2');

    // Agent-1 claims task with files
    const t1 = await createTask('Task 1', ['Source/Shared.cpp']);
    await claimTask(t1, 'pump-1');

    // Create second task with same files
    const t2 = await createTask('Task 2', ['Source/Shared.cpp']);

    // Agent-2 cannot claim (file conflict)
    const blocked = await claimTask(t2, 'pump-2');
    assert.equal(blocked.statusCode, 409);

    // Release all files
    await ctx.app.inject({ method: 'POST', url: '/coalesce/release' });

    // Now agent-2 can claim
    const unblocked = await claimTask(t2, 'pump-2');
    assert.equal(unblocked.statusCode, 200);
  });

  it('GET /coalesce/status with zero agents returns canCoalesce true and empty agents', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/coalesce/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.canCoalesce, true);
    assert.deepEqual(body.agents, []);
    assert.equal(body.pendingTasks, 0);
    assert.equal(body.totalClaimedFiles, 0);
  });

  it('GET /coalesce/status agents include correct ownedFiles and activeTasks', async () => {
    await registerAgent('pump-1');
    const taskId = await createTask('Task with files', ['Source/X.cpp', 'Source/Y.cpp']);
    await claimTask(taskId, 'pump-1');

    const res = await ctx.app.inject({ method: 'GET', url: '/coalesce/status' });
    const body = res.json();
    const agent = body.agents.find((a: { name: string }) => a.name === 'pump-1');
    assert.ok(agent);
    assert.deepEqual(agent.ownedFiles.sort(), ['Source/X.cpp', 'Source/Y.cpp']);
    assert.equal(agent.activeTasks, 1);
  });

  it('POST /coalesce/pause with no pump agents returns empty arrays', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/coalesce/pause' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.paused, []);
    assert.deepEqual(body.inFlightTasks, []);
  });

  it('POST /coalesce/pause is idempotent', async () => {
    await registerAgent('pump-1');

    const res1 = await ctx.app.inject({ method: 'POST', url: '/coalesce/pause' });
    const body1 = res1.json();
    assert.ok(body1.paused.includes('pump-1'));

    const res2 = await ctx.app.inject({ method: 'POST', url: '/coalesce/pause' });
    const body2 = res2.json();
    // Agent is already paused, so it should still appear in paused list
    assert.ok(body2.paused.includes('pump-1'));

    // Verify agent is still paused
    const agentRes = await ctx.app.inject({ method: 'GET', url: '/agents/pump-1' });
    assert.equal(agentRes.json().status, 'paused');
  });

  it('POST /coalesce/pause does not pause single-mode agents', async () => {
    await registerAgent('pump-1', 'pump');
    await registerAgent('single-1', 'single');

    const res = await ctx.app.inject({ method: 'POST', url: '/coalesce/pause' });
    const body = res.json();

    // Only pump agent should be paused
    assert.ok(body.paused.includes('pump-1'));
    assert.ok(!body.paused.includes('single-1'));

    // Verify single agent status unchanged (should still be idle)
    const singleRes = await ctx.app.inject({ method: 'GET', url: '/agents/single-1' });
    assert.equal(singleRes.json().status, 'idle');
  });

  it('POST /coalesce/release with no claimed files and no paused agents returns zeros', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/coalesce/release' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.releasedFiles, 0);
    assert.deepEqual(body.resumedAgents, []);
  });

  it('POST /coalesce/release updates files and agent status together', async () => {
    await registerAgent('pump-1');
    await registerAgent('pump-2');
    const t1 = await createTask('Task A', ['Source/A.cpp']);
    const t2 = await createTask('Task B', ['Source/B.cpp']);
    await claimTask(t1, 'pump-1');
    await claimTask(t2, 'pump-2');

    // Pause both agents
    await ctx.app.inject({ method: 'POST', url: '/coalesce/pause' });

    const res = await ctx.app.inject({ method: 'POST', url: '/coalesce/release' });
    const body = res.json();

    // Both files released
    assert.equal(body.releasedFiles, 2);
    // Both agents resumed
    assert.equal(body.resumedAgents.length, 2);
    assert.ok(body.resumedAgents.includes('pump-1'));
    assert.ok(body.resumedAgents.includes('pump-2'));

    // Verify all files cleared
    const f1 = await ctx.app.inject({ method: 'GET', url: '/files?claimant=pump-1' });
    assert.equal(f1.json().length, 0);
    const f2 = await ctx.app.inject({ method: 'GET', url: '/files?claimant=pump-2' });
    assert.equal(f2.json().length, 0);

    // Verify both agents idle
    const a1 = await ctx.app.inject({ method: 'GET', url: '/agents/pump-1' });
    assert.equal(a1.json().status, 'idle');
    const a2 = await ctx.app.inject({ method: 'GET', url: '/agents/pump-2' });
    assert.equal(a2.json().status, 'idle');
  });

  it('canCoalesce true when only single-mode agents are working', async () => {
    await registerAgent('single-1', 'single');
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/single-1/status',
      payload: { status: 'working' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/coalesce/status' });
    const body = res.json();
    // canCoalesce only considers pump agents, single-mode working should not block
    assert.equal(body.canCoalesce, true);
  });
});
