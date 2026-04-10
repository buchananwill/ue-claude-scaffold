import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import { createTestConfig } from '../test-helper.js';
import { tasks, files, agents } from '../schema/tables.js';
import { eq, and, sql } from 'drizzle-orm';
import agentsPlugin from './agents.js';
import filesPlugin from './files.js';
import coalescePlugin from './coalesce.js';

describe('coalesce routes (drizzle)', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    const config = createTestConfig();
    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(filesPlugin);
    await ctx.app.register(coalescePlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  async function registerAgent(name: string, mode: string = 'pump') {
    return ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name, worktree: `/tmp/${name}`, mode },
    });
  }

  /** Create a pending task via direct DB insert */
  async function createTask(title: string, taskFiles?: string[]): Promise<number> {
    const rows = await ctx.db.insert(tasks).values({
      title,
      projectId: 'default',
    }).returning();
    const taskId = rows[0].id;

    if (taskFiles?.length) {
      for (const filePath of taskFiles) {
        await ctx.db.insert(files).values({
          projectId: 'default',
          path: filePath,
        }).onConflictDoNothing();
      }
    }

    return taskId;
  }

  /** Look up agent UUID by name */
  async function getAgentId(agentName: string): Promise<string> {
    const rows = await ctx.db.select().from(agents)
      .where(and(eq(agents.name, agentName), eq(agents.projectId, 'default')));
    return rows[0].id;
  }

  /**
   * Claim a task and set file ownership directly using Drizzle updates.
   * This is intentional state-setup for coalesce tests, not a test of the
   * claim route — it bypasses route-level validation to put the DB into
   * the exact state needed for coalesce scenarios.
   */
  async function claimTask(taskId: number, agentName: string, taskFiles?: string[]) {
    const agentId = await getAgentId(agentName);

    await ctx.db.update(tasks).set({
      status: 'claimed',
      claimedByAgentId: agentId ?? null,
      claimedAt: sql`now()`,
    }).where(eq(tasks.id, taskId));

    // Set file claimant — scoped by projectId to match the insert pattern
    if (taskFiles?.length) {
      for (const filePath of taskFiles) {
        await ctx.db.update(files).set({
          claimantAgentId: agentId ?? null,
          claimedAt: sql`now()`,
        }).where(and(eq(files.path, filePath), eq(files.projectId, 'default')));
      }
    }
  }

  it('canCoalesce true when all agents idle and no active tasks', async () => {
    await registerAgent('pump-1');
    await registerAgent('pump-2');
    await createTask('Pending task 1');
    await createTask('Pending task 2');

    const res = await ctx.app.inject({ method: 'GET', url: '/coalesce/status', headers: { 'x-project-id': 'default' } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.canCoalesce, true);
    assert.equal(body.pendingTasks, 2);
  });

  it('canCoalesce false when tasks in progress', async () => {
    await registerAgent('pump-1');
    const taskId = await createTask('Active task');
    await claimTask(taskId, 'pump-1');

    const res = await ctx.app.inject({ method: 'GET', url: '/coalesce/status', headers: { 'x-project-id': 'default' } });
    const body = res.json();
    assert.equal(body.canCoalesce, false);
    assert.ok(body.reason.includes('task'));
  });

  it('canCoalesce false when pump agent not idle/done/paused', async () => {
    await registerAgent('pump-1');
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/pump-1/status',
      headers: { 'x-project-id': 'default' },
      payload: { status: 'working' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/coalesce/status', headers: { 'x-project-id': 'default' } });
    const body = res.json();
    assert.equal(body.canCoalesce, false);
    assert.ok(body.reason.includes('pump-1'));
  });

  it('POST /coalesce/pause sets pump agents to paused', async () => {
    await registerAgent('pump-1');
    await registerAgent('pump-2');

    const res = await ctx.app.inject({ method: 'POST', url: '/coalesce/pause', headers: { 'x-project-id': 'default' } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.paused.includes('pump-1'));
    assert.ok(body.paused.includes('pump-2'));
    assert.deepEqual(body.inFlightTasks, []);

    const a1 = await ctx.app.inject({ method: 'GET', url: '/agents/pump-1', headers: { 'x-project-id': 'default' } });
    assert.equal(a1.json().status, 'paused');
    const a2 = await ctx.app.inject({ method: 'GET', url: '/agents/pump-2', headers: { 'x-project-id': 'default' } });
    assert.equal(a2.json().status, 'paused');
  });

  it('POST /coalesce/pause returns in-flight tasks', async () => {
    await registerAgent('pump-1');
    const taskId = await createTask('In-flight task');
    await claimTask(taskId, 'pump-1');

    const pump1Id = await getAgentId('pump-1');
    const res = await ctx.app.inject({ method: 'POST', url: '/coalesce/pause', headers: { 'x-project-id': 'default' } });
    const body = res.json();
    assert.equal(body.inFlightTasks.length, 1);
    assert.equal(body.inFlightTasks[0].agent, pump1Id);
    assert.equal(body.inFlightTasks[0].taskId, taskId);
    assert.equal(body.inFlightTasks[0].title, 'In-flight task');
  });

  it('POST /coalesce/release clears ownership and resumes agents', async () => {
    await registerAgent('pump-1');
    const taskId = await createTask('Task with files', ['Source/A.cpp', 'Source/B.cpp']);
    await claimTask(taskId, 'pump-1', ['Source/A.cpp', 'Source/B.cpp']);

    // Pause the agent first
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/pump-1/status',
      headers: { 'x-project-id': 'default' },
      payload: { status: 'paused' },
    });

    const res = await ctx.app.inject({ method: 'POST', url: '/coalesce/release', headers: { 'x-project-id': 'default' } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.releasedFiles, 2);
    assert.ok(body.resumedAgents.includes('pump-1'));

    // Verify files are cleared
    const filesRes = await ctx.app.inject({ method: 'GET', url: '/files?claimant=pump-1', headers: { 'x-project-id': 'default' } });
    assert.equal(filesRes.json().length, 0);

    // Verify agent is idle
    const agentRes = await ctx.app.inject({ method: 'GET', url: '/agents/pump-1', headers: { 'x-project-id': 'default' } });
    assert.equal(agentRes.json().status, 'idle');
  });

  it('GET /coalesce/status with zero agents returns canCoalesce true and empty agents', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/coalesce/status', headers: { 'x-project-id': 'default' } });
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
    await claimTask(taskId, 'pump-1', ['Source/X.cpp', 'Source/Y.cpp']);

    const res = await ctx.app.inject({ method: 'GET', url: '/coalesce/status', headers: { 'x-project-id': 'default' } });
    const body = res.json();
    const agent = body.agents.find((a: { name: string }) => a.name === 'pump-1');
    assert.ok(agent);
    assert.deepEqual(agent.ownedFiles.sort(), ['Source/X.cpp', 'Source/Y.cpp']);
    assert.equal(agent.activeTasks, 1);
  });

  it('POST /coalesce/pause with no pump agents returns empty arrays', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/coalesce/pause', headers: { 'x-project-id': 'default' } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.paused, []);
    assert.deepEqual(body.inFlightTasks, []);
  });

  it('POST /coalesce/pause is idempotent', async () => {
    await registerAgent('pump-1');

    const res1 = await ctx.app.inject({ method: 'POST', url: '/coalesce/pause', headers: { 'x-project-id': 'default' } });
    assert.equal(res1.statusCode, 200);
    const body1 = res1.json();
    assert.ok(body1.paused.includes('pump-1'));

    // Second call should succeed without errors
    const res2 = await ctx.app.inject({ method: 'POST', url: '/coalesce/pause', headers: { 'x-project-id': 'default' } });
    assert.equal(res2.statusCode, 200);

    // Agent should still be paused after two calls
    const agentRes = await ctx.app.inject({ method: 'GET', url: '/agents/pump-1', headers: { 'x-project-id': 'default' } });
    assert.equal(agentRes.json().status, 'paused');
  });

  it('POST /coalesce/pause does not pause single-mode agents', async () => {
    await registerAgent('pump-1', 'pump');
    await registerAgent('single-1', 'single');

    const res = await ctx.app.inject({ method: 'POST', url: '/coalesce/pause', headers: { 'x-project-id': 'default' } });
    const body = res.json();

    assert.ok(body.paused.includes('pump-1'));
    assert.ok(!body.paused.includes('single-1'));

    const singleRes = await ctx.app.inject({ method: 'GET', url: '/agents/single-1', headers: { 'x-project-id': 'default' } });
    assert.equal(singleRes.json().status, 'idle');
  });

  it('POST /coalesce/release with no claimed files and no paused agents returns zeros', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/coalesce/release', headers: { 'x-project-id': 'default' } });
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
    await claimTask(t1, 'pump-1', ['Source/A.cpp']);
    await claimTask(t2, 'pump-2', ['Source/B.cpp']);

    // Pause both agents
    await ctx.app.inject({ method: 'POST', url: '/coalesce/pause', headers: { 'x-project-id': 'default' } });

    const res = await ctx.app.inject({ method: 'POST', url: '/coalesce/release', headers: { 'x-project-id': 'default' } });
    const body = res.json();

    assert.equal(body.releasedFiles, 2);
    assert.equal(body.resumedAgents.length, 2);
    assert.ok(body.resumedAgents.includes('pump-1'));
    assert.ok(body.resumedAgents.includes('pump-2'));

    // Verify all files cleared
    const f1 = await ctx.app.inject({ method: 'GET', url: '/files?claimant=pump-1', headers: { 'x-project-id': 'default' } });
    assert.equal(f1.json().length, 0);
    const f2 = await ctx.app.inject({ method: 'GET', url: '/files?claimant=pump-2', headers: { 'x-project-id': 'default' } });
    assert.equal(f2.json().length, 0);

    // Verify both agents idle
    const a1 = await ctx.app.inject({ method: 'GET', url: '/agents/pump-1', headers: { 'x-project-id': 'default' } });
    assert.equal(a1.json().status, 'idle');
    const a2 = await ctx.app.inject({ method: 'GET', url: '/agents/pump-2', headers: { 'x-project-id': 'default' } });
    assert.equal(a2.json().status, 'idle');
  });

  it('canCoalesce true when only single-mode agents are working', async () => {
    await registerAgent('single-1', 'single');
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/single-1/status',
      headers: { 'x-project-id': 'default' },
      payload: { status: 'working' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/coalesce/status', headers: { 'x-project-id': 'default' } });
    const body = res.json();
    assert.equal(body.canCoalesce, true);
  });

  // ── POST /coalesce/drain tests ────────────────────────────────────────────

  it('POST /coalesce/drain returns drained true when no active tasks', async () => {
    await registerAgent('pump-1');
    await registerAgent('pump-2');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/coalesce/drain',
      headers: { 'x-project-id': 'default' },
      payload: { timeout: 5 },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.drained, true);
    assert.equal(body.timedOut, false);
    assert.ok(body.paused.includes('pump-1'));
    assert.ok(body.paused.includes('pump-2'));
    assert.deepEqual(body.inFlightAtStart, []);
    assert.equal(body.activeTasks, 0);
  });

  it('POST /coalesce/drain reports in-flight tasks at start', async () => {
    await registerAgent('pump-1');
    const taskId = await createTask('Drain task');
    await claimTask(taskId, 'pump-1');

    // Use a short timeout so the drain times out (task stays active).
    // We just want to verify inFlightAtStart is populated.
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/coalesce/drain',
      headers: { 'x-project-id': 'default' },
      payload: { timeout: 1 },
    });
    const body = res.json();
    assert.equal(body.inFlightAtStart.length, 1);
    assert.equal(body.inFlightAtStart[0].taskId, taskId);
    assert.equal(body.inFlightAtStart[0].title, 'Drain task');
    assert.equal(body.timedOut, true);
  });

  it('POST /coalesce/drain times out when tasks remain active', async () => {
    await registerAgent('pump-1');
    const taskId = await createTask('Stuck task');
    await claimTask(taskId, 'pump-1');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/coalesce/drain',
      headers: { 'x-project-id': 'default' },
      payload: { timeout: 1 },
    });
    const body = res.json();
    assert.equal(body.drained, false);
    assert.equal(body.timedOut, true);
    assert.equal(body.activeTasks, 1);
  });

  it('POST /coalesce/drain uses X-Project-Id header for project scoping', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/coalesce/drain',
      headers: { 'x-project-id': 'my-project' },
      payload: { timeout: 1 },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.drained, true);
  });

  it('POST /coalesce/drain with no body uses defaults', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/coalesce/drain',
      headers: { 'x-project-id': 'default' },
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.drained, true);
  });

  it('POST /coalesce/drain with absent body (no Content-Type) uses defaults', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/coalesce/drain',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.drained, true);
    assert.equal(body.timedOut, false);
  });
});
