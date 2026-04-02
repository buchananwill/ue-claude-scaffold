import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestConfig } from '../test-helper.js';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import tasksPlugin from './tasks.js';
import filesPlugin from './files.js';

describe('file write ownership', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    const config = createTestConfig();
    await ctx.app.register(tasksPlugin, { config });
    await ctx.app.register(filesPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  async function createTask(title: string, files: string[]): Promise<number> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title, files },
    });
    return res.json().id;
  }

  async function claimTask(id: number, agent: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-agent-name': agent },
    });
  }

  async function getFiles(query?: string) {
    const url = query ? `/files?${query}` : '/files';
    const res = await ctx.app.inject({ method: 'GET', url });
    return res.json();
  }

  it('agent-1 claims task with files [A, B] -> files show claimant = agent-1', async () => {
    const taskId = await createTask('Task 1', ['Source/A.cpp', 'Source/B.cpp']);
    const res = await claimTask(taskId, 'agent-1');
    assert.equal(res.statusCode, 200);

    const files = await getFiles('claimant=agent-1');
    const paths = files.map((f: { path: string }) => f.path).sort();
    assert.deepEqual(paths, ['Source/A.cpp', 'Source/B.cpp']);
    for (const f of files) {
      assert.equal(f.claimant, 'agent-1');
    }
  });

  it('agent-2 tries to claim task with overlapping file -> 409 with conflict', async () => {
    const t1 = await createTask('Task 1', ['Source/A.cpp', 'Source/B.cpp']);
    await claimTask(t1, 'agent-1');

    const t2 = await createTask('Task 2', ['Source/B.cpp', 'Source/C.cpp']);
    const res = await claimTask(t2, 'agent-2');
    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.equal(body.conflicts.length, 1);
    assert.equal(body.conflicts[0].file, 'Source/B.cpp');
    assert.equal(body.conflicts[0].claimant, 'agent-1');
  });

  it('agent-2 claims task with non-overlapping files -> succeeds', async () => {
    const t1 = await createTask('Task 1', ['Source/A.cpp', 'Source/B.cpp']);
    await claimTask(t1, 'agent-1');

    const t2 = await createTask('Task 2', ['Source/C.cpp', 'Source/D.cpp']);
    const res = await claimTask(t2, 'agent-2');
    assert.equal(res.statusCode, 200);

    const files = await getFiles('claimant=agent-2');
    const paths = files.map((f: { path: string }) => f.path).sort();
    assert.deepEqual(paths, ['Source/C.cpp', 'Source/D.cpp']);
  });

  it('agent-1 completes task -> files still have claimant = agent-1 (sticky)', async () => {
    const t1 = await createTask('Task 1', ['Source/A.cpp', 'Source/B.cpp']);
    await claimTask(t1, 'agent-1');

    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${t1}/complete`,
      payload: { result: { summary: 'Done' } },
    });

    const files = await getFiles('claimant=agent-1');
    assert.equal(files.length, 2);
  });

  it('after task completion, agent-2 still gets 409 on agent-1 owned files', async () => {
    const t1 = await createTask('Task 1', ['Source/A.cpp']);
    await claimTask(t1, 'agent-1');

    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${t1}/complete`,
      payload: { result: { summary: 'Done' } },
    });

    const t2 = await createTask('Task 2', ['Source/A.cpp']);
    const res = await claimTask(t2, 'agent-2');
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().conflicts[0].file, 'Source/A.cpp');
    assert.equal(res.json().conflicts[0].claimant, 'agent-1');
  });

  it('task with no file dependencies -> no ownership check, always claimable', async () => {
    const t1 = await createTask('No files task', []);
    const res = await claimTask(t1, 'agent-1');
    assert.equal(res.statusCode, 200);
  });

  it('same agent claims two tasks sharing a file -> succeeds (self-overlap OK)', async () => {
    const t1 = await createTask('Task 1', ['Source/A.cpp', 'Source/B.cpp']);
    await claimTask(t1, 'agent-1');

    const t2 = await createTask('Task 2', ['Source/A.cpp', 'Source/C.cpp']);
    const res = await claimTask(t2, 'agent-1');
    assert.equal(res.statusCode, 200);

    const files = await getFiles('claimant=agent-1');
    const paths = files.map((f: { path: string }) => f.path).sort();
    assert.deepEqual(paths, ['Source/A.cpp', 'Source/B.cpp', 'Source/C.cpp']);
  });

  // NOTE: Agent deregistration releasing files is tested in agents.test.ts

  it('releasing a claimed task back to pending does NOT release file ownership', async () => {
    const t1 = await createTask('Task 1', ['Source/A.cpp', 'Source/B.cpp']);
    await claimTask(t1, 'agent-1');

    await ctx.app.inject({ method: 'POST', url: `/tasks/${t1}/release` });

    const files = await getFiles('claimant=agent-1');
    assert.equal(files.length, 2);

    // Another agent still cannot claim those files
    const t2 = await createTask('Task 2', ['Source/A.cpp']);
    const res = await claimTask(t2, 'agent-2');
    assert.equal(res.statusCode, 409);
  });

  it('409 response includes statusCode, error, message, and conflicts array', async () => {
    const t1 = await createTask('Task 1', ['Source/A.cpp']);
    await claimTask(t1, 'agent-1');

    const t2 = await createTask('Task 2', ['Source/A.cpp']);
    const res = await claimTask(t2, 'agent-2');
    assert.equal(res.statusCode, 409);

    const body = res.json();
    assert.equal(body.statusCode, 409);
    assert.equal(body.error, 'Conflict');
    assert.equal(typeof body.message, 'string');
    assert.ok(body.message.includes('ownership'));
    assert.ok(Array.isArray(body.conflicts));
    assert.equal(body.conflicts.length, 1);
    assert.deepEqual(Object.keys(body.conflicts[0]).sort(), ['claimant', 'file']);
  });

  it('409 lists all conflicting files when multiple overlap', async () => {
    const t1 = await createTask('Task 1', ['Source/A.cpp', 'Source/B.cpp', 'Source/C.cpp']);
    await claimTask(t1, 'agent-1');

    const t2 = await createTask('Task 2', ['Source/A.cpp', 'Source/B.cpp', 'Source/D.cpp']);
    const res = await claimTask(t2, 'agent-2');
    assert.equal(res.statusCode, 409);

    const body = res.json();
    const conflictFiles = body.conflicts.map((c: { file: string }) => c.file).sort();
    assert.deepEqual(conflictFiles, ['Source/A.cpp', 'Source/B.cpp']);
    for (const c of body.conflicts) {
      assert.equal(c.claimant, 'agent-1');
    }
  });

  // NOTE: Bulk agent delete releasing files is tested in agents.test.ts

  it('failing a task does NOT release file ownership (sticky)', async () => {
    const t1 = await createTask('Task 1', ['Source/A.cpp', 'Source/B.cpp']);
    await claimTask(t1, 'agent-1');

    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${t1}/fail`,
      payload: { error: 'compilation error' },
    });

    const files = await getFiles('claimant=agent-1');
    assert.equal(files.length, 2);

    // Another agent still blocked
    const t2 = await createTask('Task 2', ['Source/A.cpp']);
    const res = await claimTask(t2, 'agent-2');
    assert.equal(res.statusCode, 409);
  });

  it('three agents: only conflicting pairs blocked, non-overlapping succeeds', async () => {
    const t1 = await createTask('Task 1', ['Source/A.cpp']);
    await claimTask(t1, 'agent-1');

    const t2 = await createTask('Task 2', ['Source/B.cpp']);
    const res2 = await claimTask(t2, 'agent-2');
    assert.equal(res2.statusCode, 200);

    // agent-3 tries to claim A (owned by agent-1) -> blocked
    const t3 = await createTask('Task 3', ['Source/A.cpp']);
    const res3 = await claimTask(t3, 'agent-3');
    assert.equal(res3.statusCode, 409);
    assert.equal(res3.json().conflicts[0].claimant, 'agent-1');

    // agent-3 claims non-overlapping file -> succeeds
    const t4 = await createTask('Task 4', ['Source/C.cpp']);
    const res4 = await claimTask(t4, 'agent-3');
    assert.equal(res4.statusCode, 200);
  });
});
