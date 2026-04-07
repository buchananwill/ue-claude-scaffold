import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createTestConfig } from '../test-helper.js';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import { sql } from 'drizzle-orm';
import tasksPlugin from './tasks.js';
import agentsPlugin from './agents.js';

describe('tasks routes', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    const config = createTestConfig();
    await ctx.app.register(tasksPlugin, { config });
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it('POST /tasks creates a task and returns id', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Build widget', description: 'Create the widget system' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.id, 'number');
  });

  it('GET /tasks returns all tasks', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Task A' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Task B' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as any;
    const tasks = body.tasks;
    assert.equal(body.total, 2);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].title, 'Task A');
    assert.equal(tasks[1].title, 'Task B');
  });

  it('GET /tasks?status=pending filters by status', async () => {
    // Create two tasks, claim one so its status changes
    const r1 = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Pending task' },
    });
    const r2 = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Claimed task' },
    });
    const claimedId = r2.json().id;

    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${claimedId}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?status=pending' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as any;
    const tasks = body.tasks;
    assert.equal(body.total, 1);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, 'Pending task');
    assert.equal(tasks[0].status, 'pending');
  });

  it('GET /tasks supports limit and offset pagination', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'T1' } });
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'T2' } });
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'T3' } });

    const page1 = await ctx.app.inject({ method: 'GET', url: '/tasks?limit=2&offset=0' });
    const body1 = page1.json() as any;
    assert.equal(body1.tasks.length, 2);
    assert.equal(body1.total, 3);

    const page2 = await ctx.app.inject({ method: 'GET', url: '/tasks?limit=2&offset=2' });
    const body2 = page2.json() as any;
    assert.equal(body2.tasks.length, 1);
    assert.equal(body2.total, 3);
  });

  it('GET /tasks with multi-status filter', async () => {
    // Create tasks, then manually change one status via direct claim
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Pending1' } });
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Pending2' } });

    // Get all with status=pending
    const res1 = await ctx.app.inject({ method: 'GET', url: '/tasks?status=pending' });
    const body1 = res1.json() as any;
    assert.equal(body1.tasks.length, 2);
    assert.equal(body1.total, 2);

    // Multi-status: pending,completed (only pending exist)
    const res2 = await ctx.app.inject({ method: 'GET', url: '/tasks?status=pending,completed' });
    const body2 = res2.json() as any;
    assert.equal(body2.tasks.length, 2);
    assert.equal(body2.total, 2);
  });

  it('GET /tasks with priority filter', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'P0', priority: 0 } });
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'P1', priority: 1 } });
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'P2', priority: 2 } });

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?priority=0,2' });
    const body = res.json() as any;
    assert.equal(body.tasks.length, 2);
    assert.equal(body.total, 2);
    const priorities = body.tasks.map((t: any) => t.priority);
    assert.ok(priorities.includes(0));
    assert.ok(priorities.includes(2));
  });

  it('GET /tasks with sort and dir', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'AAA', priority: 1 } });
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'ZZZ', priority: 2 } });
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'MMM', priority: 0 } });

    // Sort by title ascending
    const res1 = await ctx.app.inject({ method: 'GET', url: '/tasks?sort=title&dir=asc' });
    const body1 = res1.json() as any;
    assert.equal(body1.tasks[0].title, 'AAA');
    assert.equal(body1.tasks[1].title, 'MMM');
    assert.equal(body1.tasks[2].title, 'ZZZ');

    // Sort by title descending
    const res2 = await ctx.app.inject({ method: 'GET', url: '/tasks?sort=title&dir=desc' });
    const body2 = res2.json() as any;
    assert.equal(body2.tasks[0].title, 'ZZZ');
    assert.equal(body2.tasks[2].title, 'AAA');
  });

  it('GET /tasks with invalid sort column returns 400', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?sort=bogus' });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.ok(body.message.includes('Invalid sort column'));
  });

  it('GET /tasks with invalid dir returns 400', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?sort=title&dir=sideways' });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.ok(body.message.includes('Invalid dir'));
  });

  it('GET /tasks with agent filter', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Unassigned1' } });
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Unassigned2' } });

    // Filter by __unassigned__ (both tasks have null claimedBy)
    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?agent=__unassigned__' });
    const body = res.json() as any;
    assert.equal(body.tasks.length, 2);
    assert.equal(body.total, 2);
  });

  it('GET /tasks priority filter returns 400 for non-numeric values', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'P0', priority: 0 } });

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?priority=0,abc' });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('Invalid priority'));
  });

  it('GET /tasks priority filter returns 400 for trailing comma (empty segment)', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'P0', priority: 0 } });

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?priority=0,' });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('empty segments'));
  });

  it('GET /tasks priority filter returns 400 for leading comma (empty segment)', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'P1', priority: 1 } });

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?priority=,1' });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('empty segments'));
  });

  it('GET /tasks filtered total matches filtered count, not global count', async () => {
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'P0', priority: 0 } });
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'P1', priority: 1 } });
    await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'P2', priority: 2 } });

    const res = await ctx.app.inject({ method: 'GET', url: '/tasks?priority=1' });
    const body = res.json() as any;
    assert.equal(body.tasks.length, 1);
    assert.equal(body.total, 1); // not 3!
  });

  it('GET /tasks/:id returns a single task', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'My task', description: 'Details here', priority: 5 },
    });
    const id = post.json().id;

    const res = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    assert.equal(res.statusCode, 200);
    const task = res.json();
    assert.equal(task.id, id);
    assert.equal(task.title, 'My task');
    assert.equal(task.description, 'Details here');
    assert.equal(task.priority, 5);
    assert.equal(task.status, 'pending');
    assert.equal(task.claimedBy, null);
    assert.ok(task.createdAt);
  });

  it('GET /tasks/:id returns 404 for missing task', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/tasks/99999' });
    assert.equal(res.statusCode, 404);
  });

  // ── PATCH /tasks/:id ─────────────────────────────────────────────────

  it('PATCH /tasks/:id updates title of a pending task', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Original title' },
    });
    const id = post.json().id;

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { title: 'Updated title' },
    });
    assert.equal(patch.statusCode, 200);
    assert.deepEqual(patch.json(), { ok: true });

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.equal(task.title, 'Updated title');
  });

  it('PATCH /tasks/:id partial update only touches provided fields', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Keep me', description: 'Original desc', priority: 3 },
    });
    const id = post.json().id;

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { priority: 10 },
    });
    assert.equal(patch.statusCode, 200);

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.equal(task.title, 'Keep me');
    assert.equal(task.description, 'Original desc');
    assert.equal(task.priority, 10);
  });

  it('PATCH /tasks/:id returns 404 for missing task', async () => {
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: '/tasks/99999',
      payload: { title: 'Nope' },
    });
    assert.equal(patch.statusCode, 404);
  });

  it('PATCH /tasks/:id returns 409 when task is claimed', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Will be claimed' },
    });
    const id = post.json().id;

    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { title: 'Too late' },
    });
    assert.equal(patch.statusCode, 409);
  });

  it('PATCH /tasks/:id returns 409 when task is completed', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Will be completed' },
    });
    const id = post.json().id;

    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id}/complete`,
      payload: { result: { summary: 'Done' } },
    });

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { title: 'Too late' },
    });
    assert.equal(patch.statusCode, 409);
  });

  it('PATCH /tasks/:id returns 400 when body has no updatable fields', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Untouched' },
    });
    const id = post.json().id;

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { bogus: 'field' },
    });
    assert.equal(patch.statusCode, 400);
  });

  it('PATCH /tasks/:id allows clearing sourcePath to null', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Has no source' },
    });
    const id = post.json().id;

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { sourcePath: null },
    });
    assert.equal(patch.statusCode, 200);
    assert.deepEqual(patch.json(), { ok: true });

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    assert.equal(get.json().sourcePath, null);
  });

  // ── File dependencies (Phase 1) ──────────────────────────────────────

  it('POST /tasks with files array creates task_files rows and registers files', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: {
        title: 'With files',
        files: ['Source/Foo.cpp', 'Source/Foo.h'],
      },
    });
    assert.equal(res.statusCode, 200);
    const { id } = res.json();

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.deepEqual(task.files, ['Source/Foo.cpp', 'Source/Foo.h']);
  });

  it('POST /tasks without files returns files as empty array', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'No files' },
    });
    const { id } = res.json();

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    assert.deepEqual(get.json().files, []);
  });

  it('POST /tasks with invalid file path returns 400', async () => {
    const cases = [
      { files: ['../etc/passwd'], label: '..' },
      { files: ['/absolute/path'], label: 'absolute' },
      { files: [''], label: 'empty' },
    ];
    for (const { files, label } of cases) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: `Bad path (${label})`, files },
      });
      assert.equal(res.statusCode, 400, `Expected 400 for ${label} path`);
    }
  });

  it('GET /tasks/:id returns files array', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Files test', files: ['A.cpp', 'B.h'] },
    });
    const { id } = post.json();

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.equal(Array.isArray(task.files), true);
    assert.equal(task.files.length, 2);
    assert.ok(task.files.includes('A.cpp'));
    assert.ok(task.files.includes('B.h'));
  });

  it('PATCH /tasks/:id can update files on pending task', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Patch files', files: ['Old.cpp'] },
    });
    const { id } = post.json();

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { files: ['New.cpp', 'New.h'] },
    });
    assert.equal(patch.statusCode, 200);

    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    const task = get.json();
    assert.deepEqual(task.files.sort(), ['New.cpp', 'New.h']);
  });

  it('DELETE /tasks/:id cascades to task_files', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Delete me', files: ['Doomed.cpp'] },
    });
    const { id } = post.json();

    const del = await ctx.app.inject({ method: 'DELETE', url: `/tasks/${id}` });
    assert.equal(del.statusCode, 200);

    // Task gone
    const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
    assert.equal(get.statusCode, 404);
  });

  it('POST /tasks/batch creates all tasks atomically with file registrations', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/batch',
      payload: {
        tasks: [
          { title: 'Batch 1', files: ['Shared.cpp'] },
          { title: 'Batch 2', priority: 5, files: ['Shared.cpp', 'Only2.h'] },
          { title: 'Batch 3' },
        ],
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.ids.length, 3);

    // Verify files on each task
    const get1 = await ctx.app.inject({ method: 'GET', url: `/tasks/${body.ids[0]}` });
    assert.deepEqual(get1.json().files, ['Shared.cpp']);

    const get2 = await ctx.app.inject({ method: 'GET', url: `/tasks/${body.ids[1]}` });
    assert.deepEqual(get2.json().files.sort(), ['Only2.h', 'Shared.cpp']);

    const get3 = await ctx.app.inject({ method: 'GET', url: `/tasks/${body.ids[2]}` });
    assert.deepEqual(get3.json().files, []);
  });

  it('POST /tasks/batch rolls back entirely if any task fails validation', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/batch',
      payload: {
        tasks: [
          { title: 'Good task' },
          { title: 'Bad task', files: ['../escape'] },
        ],
      },
    });
    assert.equal(res.statusCode, 400);

    // No tasks should have been created
    const list = await ctx.app.inject({ method: 'GET', url: '/tasks' });
    assert.equal((list.json() as any).tasks.length, 0);
  });

  it('batch with ?replan=true returns replan summary', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/batch?replan=true',
      payload: {
        tasks: [
          { title: 'Root', priority: 10 },
          { title: 'Middle', priority: 0, dependsOnIndex: [0] },
          { title: 'Leaf', priority: 0, dependsOnIndex: [1] },
        ],
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.ids.length, 3);

    // replan summary must be present
    assert.ok(body.replan, 'expected replan key in response');
    assert.equal(body.replan.ok, true);
    assert.ok(body.replan.replanned >= 3, `expected replanned >= 3, got ${body.replan.replanned}`);
    assert.ok(Array.isArray(body.replan.cycles));
    assert.equal(body.replan.cycles.length, 0);

    // The root task's priority should have been recomputed by replan
    const rootTask = await ctx.app.inject({ method: 'GET', url: `/tasks/${body.ids[0]}` });
    assert.equal(rootTask.statusCode, 200);
    // Priority was recomputed — just verify it's a number (replan may adjust it)
    assert.equal(typeof rootTask.json().priority, 'number');
  });

  it('batch without ?replan=true has no replan key', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/batch',
      payload: {
        tasks: [
          { title: 'Solo task' },
        ],
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.replan, undefined);
  });

  it('POST /tasks rejects unknown fields with 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Test', source_path: 'snake_case_mistake' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('source_path'));
  });

  it('PATCH /tasks/:id rejects unknown fields with 400', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Test' },
    });
    const { id } = post.json();

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      payload: { source_path: 'oops' },
    });
    assert.equal(patch.statusCode, 400);
    assert.ok(patch.json().message.includes('source_path'));
  });

});

describe('tasks with bare repo and agents', () => {
  let ctx: DrizzleTestContext;
  let tmpBareRepo: string;
  let tmpDir: string;

  function initBareRepoWithBranch(dir: string, branchName: string): { repo: string; initSha: string } {
    const repo = path.join(dir, 'test.git');
    execSync(`git init --bare "${repo}"`);
    const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const initSha = execSync(`git -C "${repo}" commit-tree ${emptyTree} -m "init"`, { encoding: 'utf-8' }).trim();
    execSync(`git -C "${repo}" update-ref refs/heads/${branchName} ${initSha}`);
    return { repo, initSha };
  }

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    tmpDir = mkdtempSync(path.join(tmpdir(), 'scaffold-test-'));
    const { repo, initSha } = initBareRepoWithBranch(tmpDir, 'docker/default/current-root');
    tmpBareRepo = repo;

    // Create agent branches from the same initial commit
    execSync(`git -C "${tmpBareRepo}" update-ref refs/heads/docker/default/agent-1 ${initSha}`);
    execSync(`git -C "${tmpBareRepo}" update-ref refs/heads/docker/default/agent-2 ${initSha}`);

    const config = createTestConfig({
      server: { port: 9100, ubtLockTimeoutMs: 600000, bareRepoPath: tmpBareRepo },
    });
    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(tasksPlugin, { config });

    // Register agents in DB
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
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // ── Task Dependencies ────────────────────────────────────────────────

  describe('task dependencies', () => {
    it('POST /tasks with dependsOn inserts dependency rows and returns them', async () => {
      const r1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Dep A' },
      });
      const depId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Dep B', dependsOn: [depId] },
      });
      assert.equal(r2.statusCode, 200);
      assert.equal(r2.json().ok, true);

      const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${r2.json().id}` });
      const task = get.json();
      assert.deepEqual(task.dependsOn, [depId]);
      assert.deepEqual(task.blockedBy, [depId]);
    });

    it('POST /tasks with dependsOn referencing non-existent task returns 400', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Bad dep', dependsOn: [99999] },
      });
      assert.equal(res.statusCode, 400);
      assert.ok(res.json().message.includes('does not exist'));
    });

    it('POST /tasks/claim-next skips tasks with unmet dependencies', async () => {
      const r1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Blocker' },
      });
      const blockerId = r1.json().id;

      await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Blocked task', dependsOn: [blockerId] },
      });

      const claim = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim.statusCode, 200);
      const body = claim.json();
      assert.ok(body.task);
      assert.equal(body.task.title, 'Blocker');
    });

    it('POST /tasks/claim-next claims task when dependency is completed', async () => {
      const r1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Prereq' },
      });
      const prereqId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Dependent', dependsOn: [prereqId] },
      });
      const depTaskId = r2.json().id;

      // Claim and complete the prereq (same agent will claim the dependent)
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${prereqId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${prereqId}/complete`,
        payload: { result: { done: true, agent: 'agent-1' } },
      });

      // Now claim-next as same agent should pick up the dependent task
      const claim = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim.statusCode, 200);
      assert.ok(claim.json().task);
      assert.equal(claim.json().task.id, depTaskId);
    });

    it('POST /tasks/:id/claim returns 409 with blockedBy when dependency unmet', async () => {
      const r1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Blocker for claim' },
      });
      const blockerId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Cannot claim yet', dependsOn: [blockerId] },
      });
      const taskId = r2.json().id;

      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim.statusCode, 409);
      const body = claim.json();
      assert.equal(body.message, 'Task has unmet dependencies');
      assert.deepEqual(body.blockedBy, [blockerId]);
    });

    it('POST /tasks/:id/claim succeeds when all dependencies completed by same agent', async () => {
      const r1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Prereq for claim' },
      });
      const prereqId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Claimable after prereq', dependsOn: [prereqId] },
      });
      const taskId = r2.json().id;

      // Complete prereq as agent-1
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${prereqId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${prereqId}/complete`,
        payload: { result: { done: true, agent: 'agent-1' } },
      });

      // Claim as same agent (agent-1) — branch-aware: dep completed by same agent is met
      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim.statusCode, 200);
      assert.deepEqual(claim.json(), { ok: true });
    });

    it('POST /tasks/batch with dependsOnIndex resolves cross-references', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/batch',
        payload: {
          tasks: [
            { title: 'Batch A' },
            { title: 'Batch B', dependsOnIndex: [0] },
            { title: 'Batch C', dependsOnIndex: [0, 1] },
          ],
        },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.ids.length, 3);

      // Verify deps
      const getB = await ctx.app.inject({ method: 'GET', url: `/tasks/${body.ids[1]}` });
      assert.deepEqual(getB.json().dependsOn, [body.ids[0]]);

      const getC = await ctx.app.inject({ method: 'GET', url: `/tasks/${body.ids[2]}` });
      assert.deepEqual(getC.json().dependsOn.sort(), [body.ids[0], body.ids[1]].sort());
    });

    it('POST /tasks/batch with dependsOnIndex self-reference returns 400', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/batch',
        payload: {
          tasks: [
            { title: 'Self ref', dependsOnIndex: [0] },
          ],
        },
      });
      assert.equal(res.statusCode, 400);
      assert.ok(res.json().message.includes('self'));
    });

    it('GET /tasks/:id returns dependsOn and blockedBy arrays', async () => {
      const r1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Parent' },
      });
      const parentId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Child', dependsOn: [parentId] },
      });
      const childId = r2.json().id;

      const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${childId}` });
      const task = get.json();
      assert.deepEqual(task.dependsOn, [parentId]);
      assert.deepEqual(task.blockedBy, [parentId]);

      // Complete parent with agent tag, blockedBy should become empty for same agent
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${parentId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${parentId}/complete`,
        payload: { result: { agent: 'agent-1' } },
      });

      // GET as agent-1 (who completed the parent) — blockedBy should be empty
      const get2 = await ctx.app.inject({
        method: 'GET',
        url: `/tasks/${childId}`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      const task2 = get2.json();
      assert.deepEqual(task2.dependsOn, [parentId]);
      assert.deepEqual(task2.blockedBy, []);
    });

    it('PATCH /tasks/:id with dependsOn updates dependency list', async () => {
      const r1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Dep X' },
      });
      const depX = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Dep Y' },
      });
      const depY = r2.json().id;

      const r3 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Patchable', dependsOn: [depX] },
      });
      const taskId = r3.json().id;

      // Verify initial deps
      const get1 = await ctx.app.inject({ method: 'GET', url: `/tasks/${taskId}` });
      assert.deepEqual(get1.json().dependsOn, [depX]);

      // Patch to new deps
      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/tasks/${taskId}`,
        payload: { dependsOn: [depY] },
      });
      assert.equal(patch.statusCode, 200);

      const get2 = await ctx.app.inject({ method: 'GET', url: `/tasks/${taskId}` });
      assert.deepEqual(get2.json().dependsOn, [depY]);
    });

    it('PATCH /tasks/:id with dependsOn creating a mutual cycle returns 400', async () => {
      const r1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Cycle A' },
      });
      const idA = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Cycle B', dependsOn: [idA] },
      });
      const idB = r2.json().id;

      // Try to make A depend on B — should fail with cycle error
      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/tasks/${idA}`,
        payload: { dependsOn: [idB] },
      });
      assert.equal(patch.statusCode, 400);
      assert.ok(patch.json().message.includes('Cycle detected'));
    });

    it('task with multiple deps where only some are completed remains blocked', async () => {
      // Create two prerequisite tasks
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep 1' } });
      const r2 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep 2' } });
      const dep1 = r1.json().id;
      const dep2 = r2.json().id;

      // Create a task that depends on both
      const r3 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Needs both', dependsOn: [dep1, dep2] },
      });
      const taskId = r3.json().id;

      // Complete only dep1 as agent-1
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep1}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep1}/complete`, payload: { result: { done: true, agent: 'agent-1' } } });

      // blockedBy (viewed as agent-1) should only contain dep2 now
      const get = await ctx.app.inject({
        method: 'GET',
        url: `/tasks/${taskId}`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      const task = get.json();
      assert.deepEqual(task.dependsOn.sort(), [dep1, dep2].sort());
      assert.deepEqual(task.blockedBy, [dep2]);

      // claim as agent-1 should still fail (dep2 is still pending)
      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim.statusCode, 409);
      assert.deepEqual(claim.json().blockedBy, [dep2]);

      // claim-next as agent-1 should not return the blocked task (should return dep2 instead)
      const claimNext = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claimNext.statusCode, 200);
      assert.equal(claimNext.json().task.title, 'Dep 2');
    });

    it('full lifecycle: complete dependency then claim dependent task (same agent)', async () => {
      // Create prerequisite
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Prerequisite' } });
      const prereqId = r1.json().id;

      // Create dependent task
      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Dependent task', dependsOn: [prereqId] },
      });
      const depId = r2.json().id;

      // Verify initially blocked
      const claim1 = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${depId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim1.statusCode, 409);

      // Claim, update, complete the prerequisite as agent-1
      await ctx.app.inject({ method: 'POST', url: `/tasks/${prereqId}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${prereqId}/update`, payload: { progress: 'Working on it' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${prereqId}/complete`, payload: { result: { summary: 'All done', agent: 'agent-1' } } });

      // Now the dependent task should be claimable by the same agent
      const claim2 = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${depId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim2.statusCode, 200);
      assert.deepEqual(claim2.json(), { ok: true });

      // Verify the claimed state (pass agent-1 header so blockedBy is evaluated from agent-1's perspective)
      const get = await ctx.app.inject({
        method: 'GET',
        url: `/tasks/${depId}`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      const task = get.json();
      assert.equal(task.status, 'claimed');
      assert.equal(task.claimedBy, 'agent-1');
      assert.deepEqual(task.dependsOn, [prereqId]);
      assert.deepEqual(task.blockedBy, []);
    });

    it('GET /tasks list returns dependsOn and blockedBy for all tasks', async () => {
      // Create tasks: one independent, one with dependency
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Independent' } });
      const indepId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Has dependency', dependsOn: [indepId] },
      });

      const list = await ctx.app.inject({ method: 'GET', url: '/tasks' });
      assert.equal(list.statusCode, 200);
      const listBody = list.json() as any;
      const tasks = listBody.tasks;
      assert.equal(tasks.length, 2);

      // Independent task should have empty arrays
      const indepTask = tasks.find((t: any) => t.title === 'Independent');
      assert.ok(indepTask);
      assert.deepEqual(indepTask.dependsOn, []);
      assert.deepEqual(indepTask.blockedBy, []);

      // Dependent task should have populated arrays
      const depTask = tasks.find((t: any) => t.title === 'Has dependency');
      assert.ok(depTask);
      assert.deepEqual(depTask.dependsOn, [indepId]);
      assert.deepEqual(depTask.blockedBy, [indepId]);
    });

    it('POST /tasks/batch with dependsOnIndex forming a chain A -> B -> C', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/batch',
        payload: {
          tasks: [
            { title: 'Chain A' },
            { title: 'Chain B', dependsOnIndex: [0] },
            { title: 'Chain C', dependsOnIndex: [1] },
          ],
        },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      const [idA, idB, idC] = body.ids;

      // Verify the chain
      const getA = await ctx.app.inject({ method: 'GET', url: `/tasks/${idA}` });
      assert.deepEqual(getA.json().dependsOn, []);
      assert.deepEqual(getA.json().blockedBy, []);

      const getB = await ctx.app.inject({ method: 'GET', url: `/tasks/${idB}` });
      assert.deepEqual(getB.json().dependsOn, [idA]);
      assert.deepEqual(getB.json().blockedBy, [idA]);

      const getC = await ctx.app.inject({ method: 'GET', url: `/tasks/${idC}` });
      assert.deepEqual(getC.json().dependsOn, [idB]);
      assert.deepEqual(getC.json().blockedBy, [idB]);

      // claim-next should only return A (B and C are blocked)
      const claim1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim1.json().task.title, 'Chain A');

      // Complete directly from 'claimed' — the server permits this transition.
      // If status constraints are tightened in the future, add an /update step here.
      // Complete A, then B should become claimable but C should still be blocked
      await ctx.app.inject({ method: 'POST', url: `/tasks/${idA}/complete`, payload: { result: {} } });

      const claim2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claim2.json().task.title, 'Chain B');

      // C is still blocked by B
      const getC2 = await ctx.app.inject({ method: 'GET', url: `/tasks/${idC}` });
      assert.deepEqual(getC2.json().blockedBy, [idB]);
    });

    it('PATCH /tasks/:id with dependsOn: [] clears dependencies and makes task claimable', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Blocker' } });
      const blockerId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Was blocked', dependsOn: [blockerId] },
      });
      const taskId = r2.json().id;

      // Verify it is blocked
      const claim1 = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim1.statusCode, 409);

      // Clear dependencies
      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/tasks/${taskId}`,
        payload: { dependsOn: [] },
      });
      assert.equal(patch.statusCode, 200);

      // Verify dependencies are cleared
      const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${taskId}` });
      assert.deepEqual(get.json().dependsOn, []);
      assert.deepEqual(get.json().blockedBy, []);

      // Now it should be claimable
      const claim2 = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim2.statusCode, 200);
      assert.deepEqual(claim2.json(), { ok: true });
    });

    it('POST /tasks rejects dependsOnIndex in single create', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Bad', dependsOnIndex: [0] },
      });
      assert.equal(res.statusCode, 400);
      assert.ok(res.json().message.includes('dependsOnIndex is only valid in POST /tasks/batch'));
    });

    it('POST /tasks/batch with mutual dependsOnIndex cycle returns 400', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/batch',
        payload: {
          tasks: [
            { title: 'A', dependsOnIndex: [1] },
            { title: 'B', dependsOnIndex: [0] },
          ],
        },
      });
      assert.equal(res.statusCode, 400);
      assert.ok(res.json().message.includes('Cycle detected'));
    });

    it('PATCH /tasks/:id with dependsOn containing self-reference returns 400', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Self dep' } });
      const taskId = r1.json().id;

      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/tasks/${taskId}`,
        payload: { dependsOn: [taskId] },
      });
      assert.equal(patch.statusCode, 400);
      assert.ok(patch.json().message.includes('cannot depend on itself'));
    });

    it('claim-next depBlocked count reflects tasks blocked by dependencies', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Blocker task' } });
      const blockerId = r1.json().id;

      // Claim the blocker so it is no longer pending
      await ctx.app.inject({ method: 'POST', url: `/tasks/${blockerId}/claim`, headers: { 'x-agent-name': 'agent-1' } });

      // Create a task blocked by the dependency
      await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Dep blocked', dependsOn: [blockerId] },
      });

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.task, null);
      assert.equal(body.pending, 1);
      assert.equal(body.depBlocked, 1);
      assert.ok(body.reason.includes('unmet dependencies'));
    });

    describe('blockReasons field', () => {
      it('pending task with no conflicts and no deps has empty blockReasons', async () => {
        const post = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Clean task' },
        });
        const { id } = post.json();

        const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
        const task = get.json();
        assert.equal(task.status, 'pending');
        assert.deepEqual(task.blockReasons, []);
      });

      it('pending task with files locked by another agent has file-lock block reason', async () => {
        // Create and claim a task to lock files
        const r1 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Locker', files: ['Widget.cpp', 'Widget.h'] },
        });
        const lockerId = r1.json().id;
        await ctx.app.inject({
          method: 'POST',
          url: `/tasks/${lockerId}/claim`,
          headers: { 'x-agent-name': 'agent-1' },
        });

        // Create a pending task that needs the same files
        const r2 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Blocked by files', files: ['Widget.cpp'] },
        });
        const blockedId = r2.json().id;

        const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${blockedId}` });
        const task = get.json();
        assert.equal(task.status, 'pending');
        assert.ok(task.blockReasons.length > 0);
        assert.ok(task.blockReasons.some((r: string) => r.includes("files locked by agent 'agent-1'")));
        assert.ok(task.blockReasons.some((r: string) => r.includes('Widget.cpp')));
      });

      it('pending task with unmet dependency has dependency block reason', async () => {
        const r1 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Prereq' },
        });
        const prereqId = r1.json().id;

        const r2 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Dep task', dependsOn: [prereqId] },
        });
        const depTaskId = r2.json().id;

        const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${depTaskId}` });
        const task = get.json();
        assert.equal(task.status, 'pending');
        assert.ok(task.blockReasons.length > 0);
        assert.ok(task.blockReasons.some((r: string) => r.includes('blocked by incomplete task(s)')));
        assert.ok(task.blockReasons.some((r: string) => r.includes(`#${prereqId}`)));
      });

      it('pending task with missing sourcePath has sourcePath block reason', async () => {
        const post = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Missing source task' },
        });
        const { id } = post.json();

        // Bypass route validation by directly setting source_path in the DB
        await ctx.db.execute(sql`UPDATE tasks SET source_path = 'plans/nonexistent.md' WHERE id = ${id}`);

        const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` });
        const task = get.json();
        assert.equal(task.status, 'pending');
        assert.ok(task.blockReasons.length > 0);
        assert.ok(task.blockReasons.some((r: string) => r.includes('sourcePath')));
        assert.ok(task.blockReasons.some((r: string) => r.includes('not found')));
      });

      it('completed task has empty blockReasons regardless of deps', async () => {
        const r1 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Done prereq' },
        });
        const prereqId = r1.json().id;

        // Claim and complete the prereq
        await ctx.app.inject({
          method: 'POST',
          url: `/tasks/${prereqId}/claim`,
          headers: { 'x-agent-name': 'agent-1' },
        });
        await ctx.app.inject({
          method: 'POST',
          url: `/tasks/${prereqId}/complete`,
          payload: { result: { done: true } },
        });

        const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${prereqId}` });
        const task = get.json();
        assert.equal(task.status, 'completed');
        assert.deepEqual(task.blockReasons, []);
      });

      it('pending task with BOTH file conflict and unmet dependency has multiple block reasons', async () => {
        // Create a task and claim it to lock files
        const r1 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'File locker', files: ['Shared.cpp'] },
        });
        const lockerId = r1.json().id;
        await ctx.app.inject({
          method: 'POST',
          url: `/tasks/${lockerId}/claim`,
          headers: { 'x-agent-name': 'agent-lock' },
        });

        // Create an incomplete prereq task
        const r2 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Prereq task' },
        });
        const prereqId = r2.json().id;

        // Create a task that has both a file conflict AND a dependency blocker
        const r3 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Doubly blocked', files: ['Shared.cpp'], dependsOn: [prereqId] },
        });
        const blockedId = r3.json().id;

        const get = await ctx.app.inject({ method: 'GET', url: `/tasks/${blockedId}` });
        const task = get.json();
        assert.equal(task.status, 'pending');
        // Should have at least 2 reasons: file lock + dependency
        assert.ok(task.blockReasons.length >= 2, `Expected >= 2 block reasons, got ${task.blockReasons.length}`);
        assert.ok(task.blockReasons.some((r: string) => r.includes("files locked by agent 'agent-lock'")));
        assert.ok(task.blockReasons.some((r: string) => r.includes('Shared.cpp')));
        assert.ok(task.blockReasons.some((r: string) => r.includes('blocked by incomplete task(s)')));
        assert.ok(task.blockReasons.some((r: string) => r.includes(`#${prereqId}`)));
      });

      it('GET /tasks list includes blockReasons on every task', async () => {
        // Create a prereq (pending, no blocks)
        const r1 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Independent' },
        });
        const indId = r1.json().id;

        // Create a task blocked by the prereq
        const r2 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Dependent', dependsOn: [indId] },
        });
        const depId = r2.json().id;

        const list = await ctx.app.inject({ method: 'GET', url: '/tasks' });
        const listBody = list.json() as any;
        const tasks = listBody.tasks;
        assert.equal(tasks.length, 2);

        // Every task in the list should have a blockReasons array
        for (const t of tasks) {
          assert.ok(Array.isArray(t.blockReasons), `Task ${t.id} missing blockReasons array`);
        }

        // Independent task should have no block reasons
        const indTask = tasks.find((t: any) => t.id === indId);
        assert.deepEqual(indTask.blockReasons, []);

        // Dependent task should show blocked
        const depTask = tasks.find((t: any) => t.id === depId);
        assert.ok(depTask.blockReasons.length > 0);
        assert.ok(depTask.blockReasons.some((r: string) => r.includes('blocked by incomplete task(s)')));
      });

      it('block reasons disappear after the blocking condition is resolved', async () => {
        // Create a prereq task
        const r1 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Prereq to complete' },
        });
        const prereqId = r1.json().id;

        // Create a dependent task
        const r2 = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: 'Waiting on prereq', dependsOn: [prereqId] },
        });
        const waiterId = r2.json().id;

        // Confirm it is blocked initially
        const getBefore = await ctx.app.inject({ method: 'GET', url: `/tasks/${waiterId}` });
        const before = getBefore.json();
        assert.ok(before.blockReasons.length > 0, 'Should be blocked before prereq completes');
        assert.ok(before.blockReasons.some((r: string) => r.includes('blocked by incomplete task(s)')));

        // Now complete the prereq as agent-resolver
        await ctx.app.inject({
          method: 'POST',
          url: `/tasks/${prereqId}/claim`,
          headers: { 'x-agent-name': 'agent-resolver' },
        });
        await ctx.app.inject({
          method: 'POST',
          url: `/tasks/${prereqId}/complete`,
          payload: { result: { done: true, agent: 'agent-resolver' } },
        });

        // Re-fetch the dependent task as agent-resolver -- block reason should be gone
        const getAfter = await ctx.app.inject({
          method: 'GET',
          url: `/tasks/${waiterId}`,
          headers: { 'x-agent-name': 'agent-resolver' },
        });
        const after = getAfter.json();
        assert.equal(after.status, 'pending');
        assert.deepEqual(after.blockReasons, [], 'Block reasons should be empty after prereq is completed by same agent');
      });
    });

    it('claim-next prefers chain continuation over higher priority independent task', async () => {
      // Create task A (priority 5, no deps)
      const rA = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Task A', priority: 5 },
      });
      const idA = rA.json().id;

      // Create task B (priority 5, depends on A)
      const rB = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Task B', priority: 5, dependsOn: [idA] },
      });
      const idB = rB.json().id;

      // Create task C (priority 10, no deps)
      const rC = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Task C', priority: 10 },
      });
      const idC = rC.json().id;

      // Agent-1 claims A and completes it with result.agent = 'agent-1'
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${idA}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${idA}/complete`,
        payload: { result: { summary: 'done', agent: 'agent-1' } },
      });

      // claim-next as agent-1 should return B (chain continuation beats C's higher priority)
      const claim1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim1.statusCode, 200);
      assert.equal(claim1.json().task.id, idB, 'agent-1 should get task B (chain continuation)');
      assert.equal(claim1.json().task.title, 'Task B');

      // claim-next as agent-2 should return C (B is already claimed, C is highest priority remaining)
      const claim2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claim2.statusCode, 200);
      assert.equal(claim2.json().task.id, idC, 'agent-2 should get task C');
      assert.equal(claim2.json().task.title, 'Task C');
    });

    it('integrated deps resume normal priority ordering', async () => {
      // Create task A (priority 5, no deps)
      const rA = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Task A', priority: 5 },
      });
      const idA = rA.json().id;

      // Create task B (priority 5, depends on A)
      const rB = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Task B', priority: 5, dependsOn: [idA] },
      });
      const idB = rB.json().id;

      // Create task C (priority 10, no deps)
      const rC = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Task C', priority: 10 },
      });
      const idC = rC.json().id;

      // Agent-1 claims A, completes it, then integrates it
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${idA}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${idA}/complete`,
        payload: { result: { summary: 'done', agent: 'agent-1' } },
      });
      const intRes = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${idA}/integrate`,
      });
      assert.equal(intRes.statusCode, 200, 'integrate should succeed');

      // claim-next as agent-1: A is integrated, so preference tier does NOT fire.
      // Normal priority ordering applies: C (priority 10) beats B (priority 5).
      const claim1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim1.statusCode, 200);
      assert.equal(claim1.json().task.id, idC, 'agent-1 should get task C (higher priority, no chain preference after integrate)');
      assert.equal(claim1.json().task.title, 'Task C');
    });
  });

  describe('branch-aware dependency resolution', () => {
    it('agent-2 cannot claim task whose dep was completed by agent-1', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep task' } });
      const depId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Blocked task', dependsOn: [depId] },
      });
      const blockedId = r2.json().id;

      // Complete dep as agent-1
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/complete`, payload: { result: { agent: 'agent-1' } } });

      // agent-2 tries to claim the blocked task — should be denied (work on another branch)
      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${blockedId}/claim`,
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claim.statusCode, 409);
      assert.equal(claim.json().message, 'Task has unmet dependencies');
    });

    it('agent-1 can claim task whose dep was completed by agent-1', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep task' } });
      const depId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Blocked task', dependsOn: [depId] },
      });
      const blockedId = r2.json().id;

      // Complete dep as agent-1
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/complete`, payload: { result: { agent: 'agent-1' } } });

      // agent-1 claims the blocked task — should succeed (same branch)
      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${blockedId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim.statusCode, 200);
      assert.deepEqual(claim.json(), { ok: true });
    });

    it('any agent can claim task whose dep is integrated', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep task' } });
      const depId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Blocked task', dependsOn: [depId] },
      });
      const blockedId = r2.json().id;

      // Complete dep as agent-1, then integrate it
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/complete`, payload: { result: { agent: 'agent-1' } } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/integrate` });

      // agent-2 claims the blocked task — should succeed (dep is integrated, available to all)
      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${blockedId}/claim`,
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claim.statusCode, 200);
      assert.deepEqual(claim.json(), { ok: true });
    });

    it('mixed deps: one integrated + one completed by requesting agent is claimable', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep 1' } });
      const dep1 = r1.json().id;
      const r2 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep 2' } });
      const dep2 = r2.json().id;

      const r3 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Needs both', dependsOn: [dep1, dep2] },
      });
      const taskId = r3.json().id;

      // Complete dep1 as agent-1 and integrate it
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep1}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep1}/complete`, payload: { result: { agent: 'agent-1' } } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep1}/integrate` });

      // Complete dep2 as agent-1 (not integrated)
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep2}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep2}/complete`, payload: { result: { agent: 'agent-1' } } });

      // agent-1 claims — should succeed (dep1 integrated, dep2 completed by same agent)
      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim.statusCode, 200);
      assert.deepEqual(claim.json(), { ok: true });
    });

    it('mixed deps: one integrated + one completed by different agent is not claimable', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep 1' } });
      const dep1 = r1.json().id;
      const r2 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep 2' } });
      const dep2 = r2.json().id;

      const r3 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Needs both', dependsOn: [dep1, dep2] },
      });
      const taskId = r3.json().id;

      // dep1: completed by agent-1, integrated
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep1}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep1}/complete`, payload: { result: { agent: 'agent-1' } } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep1}/integrate` });

      // dep2: completed by agent-1 (not integrated)
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep2}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${dep2}/complete`, payload: { result: { agent: 'agent-1' } } });

      // agent-2 tries to claim — should fail (dep2 completed by agent-1, not integrated)
      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claim.statusCode, 409);
      const body = claim.json();
      assert.ok(body.blockReasons.some((r: string) => r.includes('blocked by work on another branch')));
      // Should NOT say "blocked by incomplete" — dep2 IS completed, just on the wrong branch
      assert.ok(!body.blockReasons.some((r: string) => r.includes('blocked by incomplete')));
    });

    it('claim-next skips task whose dep was completed by different agent', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep task' } });
      const depId = r1.json().id;

      await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Blocked task', dependsOn: [depId] },
      });

      // Complete dep as agent-1
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/complete`, payload: { result: { agent: 'agent-1' } } });

      // claim-next as agent-2 — should not return the blocked task
      const claim = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claim.statusCode, 200);
      assert.equal(claim.json().task, null);
    });

    it('claim-next returns task when dep completed by same agent', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Dep task' } });
      const depId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Blocked task', dependsOn: [depId] },
      });
      const blockedId = r2.json().id;

      // Complete dep as agent-1
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/claim`, headers: { 'x-agent-name': 'agent-1' } });
      await ctx.app.inject({ method: 'POST', url: `/tasks/${depId}/complete`, payload: { result: { agent: 'agent-1' } } });

      // claim-next as agent-1 — should return the blocked task
      const claim = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim.statusCode, 200);
      assert.ok(claim.json().task);
      assert.equal(claim.json().task.id, blockedId);
    });

    it('blockedBy in 409 response includes blockReasons distinguishing branch vs incomplete', async () => {
      const r1 = await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'Pending dep' } });
      const pendingDepId = r1.json().id;

      const r2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Blocked task', dependsOn: [pendingDepId] },
      });
      const blockedId = r2.json().id;

      // Claim the blocked task while dep is still pending — should get "blocked by incomplete"
      const claim = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${blockedId}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claim.statusCode, 409);
      const body = claim.json();
      assert.ok(body.blockReasons.some((r: string) => r.includes('blocked by incomplete task(s)')));
      assert.ok(body.blockReasons.some((r: string) => r.includes(`#${pendingDepId}`)));
    });
  });

  describe('schema — integrated and cycle statuses', () => {
    it('accepts integrated status on direct insert', async () => {
      const result = await ctx.db.execute(
        sql`INSERT INTO tasks (title, status) VALUES ('Integrated task', 'integrated') RETURNING id, status`
      );
      assert.equal(result.rows.length, 1);
      assert.equal((result.rows[0] as any).status, 'integrated');
    });

    it('accepts cycle status on direct insert', async () => {
      const result = await ctx.db.execute(
        sql`INSERT INTO tasks (title, status) VALUES ('Cycle task', 'cycle') RETURNING id, status`
      );
      assert.equal(result.rows.length, 1);
      assert.equal((result.rows[0] as any).status, 'cycle');
    });

    it('rejects invalid status values', async () => {
      await assert.rejects(
        () => ctx.db.execute(sql`INSERT INTO tasks (title, status) VALUES ('Bad task', 'invalid')`),
      );
    });

    it('CHECK constraint includes all expected statuses', async () => {
      const validStatuses = ['pending', 'claimed', 'in_progress', 'completed', 'failed', 'integrated', 'cycle'];
      for (const status of validStatuses) {
        const result = await ctx.db.execute(
          sql`INSERT INTO tasks (title, status) VALUES (${`Task ${status}`}, ${status}) RETURNING id`
        );
        assert.equal(result.rows.length, 1, `Status '${status}' should be accepted`);
      }
    });
  });

  // NOTE: SQLite migration tests (v7 to v9) removed — they test the legacy SQLite layer
  // which is no longer exercised by these route tests (now using Drizzle/PGlite).

  describe('branch-aware lifecycle integration', () => {
    /** Helper: create a task and return its id */
    async function createTask(title: string, priority?: number, dependsOn?: number[]): Promise<number> {
      const payload: Record<string, unknown> = { title };
      if (priority !== undefined) payload.priority = priority;
      if (dependsOn !== undefined) payload.dependsOn = dependsOn;
      const res = await ctx.app.inject({ method: 'POST', url: '/tasks', payload });
      assert.equal(res.statusCode, 200, `createTask '${title}' failed: ${res.body}`);
      return res.json().id;
    }

    /** Helper: add a dependency edge via direct DB insert (needed for cycles) */
    async function addDep(taskId: number, dependsOn: number): Promise<void> {
      await ctx.db.execute(sql`INSERT INTO task_dependencies (task_id, depends_on) VALUES (${taskId}, ${dependsOn}) ON CONFLICT DO NOTHING`);
    }

    /** Helper: claim a task by id for a given agent */
    async function claimTask(taskId: number, agent: string): Promise<void> {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-agent-name': agent },
      });
      assert.equal(res.statusCode, 200, `claim task ${taskId} as ${agent} failed: ${res.body}`);
    }

    /** Helper: complete a task with a result containing the agent name */
    async function completeTask(taskId: number, agent: string): Promise<void> {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/complete`,
        payload: { result: { agent } },
      });
      assert.equal(res.statusCode, 200, `complete task ${taskId} as ${agent} failed: ${res.body}`);
    }

    /** Helper: claim-next for an agent */
    async function claimNext(agent: string) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': agent },
      });
      assert.equal(res.statusCode, 200);
      return res.json();
    }

    it('full branch-aware lifecycle', async () => {
      // Create tasks A -> B -> C (C depends on B, B depends on A)
      const idA = await createTask('A', 5);
      const idB = await createTask('B', 5, [idA]);
      const idC = await createTask('C', 5, [idB]);

      // Agent-1 claims A via claim-next
      const claimA = await claimNext('agent-1');
      assert.ok(claimA.task, 'agent-1 should get task A');
      assert.equal(claimA.task.id, idA);

      // Agent-1 completes A with result: { agent: 'agent-1' }
      await completeTask(idA, 'agent-1');

      // Agent-1 CAN claim B (completed A on same branch)
      const claimB1 = await claimNext('agent-1');
      assert.ok(claimB1.task, 'agent-1 should get task B (chain continuation)');
      assert.equal(claimB1.task.id, idB);

      // Release B so we can test agent-2's inability to claim it
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${idB}/release`,
        headers: { 'x-agent-name': 'agent-1' },
      });

      // Agent-2 CANNOT claim B (A completed by agent-1, not integrated)
      const claimB2 = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${idB}/claim`,
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claimB2.statusCode, 409, 'agent-2 should be blocked from claiming B');

      // Integrate A
      const intRes = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${idA}/integrate`,
      });
      assert.equal(intRes.statusCode, 200);

      // Now agent-2 CAN claim B (A is integrated)
      const claimB2After = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${idB}/claim`,
        headers: { 'x-agent-name': 'agent-2' },
      });
      assert.equal(claimB2After.statusCode, 200, 'agent-2 should claim B after A is integrated');

      // Complete B as agent-2
      await completeTask(idB, 'agent-2');

      // Agent-2 CAN claim C (B completed by agent-2)
      const claimC2 = await claimNext('agent-2');
      assert.ok(claimC2.task, 'agent-2 should get task C (chain continuation from B)');
      assert.equal(claimC2.task.id, idC);

      // Release C so we can test agent-1's inability
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${idC}/release`,
        headers: { 'x-agent-name': 'agent-2' },
      });

      // Agent-1 CANNOT claim C (B completed by agent-2, not integrated)
      const claimC1 = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${idC}/claim`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claimC1.statusCode, 409, 'agent-1 should be blocked from claiming C');
    });

    it('preferential claiming favors chain continuation over higher priority', async () => {
      // Create independent task X (priority 10) and task A (priority 5)
      const idX = await createTask('X', 10);
      const idA = await createTask('A', 5);
      // Create dependent task B (priority 5, depends on A)
      const idB = await createTask('B', 5, [idA]);

      // Agent-1 claims and completes A
      await claimTask(idA, 'agent-1');
      await completeTask(idA, 'agent-1');

      // Agent-1's claim-next should return B (chain continuation), NOT X (higher priority)
      const result = await claimNext('agent-1');
      assert.ok(result.task, 'agent-1 should get a task');
      assert.equal(result.task.id, idB, 'should prefer chain continuation (B) over higher-priority independent task (X)');
    });

    it('replan + claim interaction with cycles', async () => {
      // Create tasks with a cycle: A depends on B, B depends on A
      const idA = await createTask('A', 5);
      const idB = await createTask('B', 5);
      await addDep(idA, idB);
      await addDep(idB, idA);

      // Create independent task C
      const idC = await createTask('C', 3);

      // Call replan
      const replanRes = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(replanRes.statusCode, 200);

      // Verify A and B have status = 'cycle'
      const tA = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idA}` })).json();
      const tB = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idB}` })).json();
      assert.equal(tA.status, 'cycle', 'A should be in cycle');
      assert.equal(tB.status, 'cycle', 'B should be in cycle');

      // claim-next returns C (cycle tasks are skipped)
      const claimResult = await claimNext('agent-1');
      assert.ok(claimResult.task, 'should get task C');
      assert.equal(claimResult.task.id, idC);

      // Release C so the queue has no claimable tasks besides the cycle
      await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${idC}/release`,
        headers: { 'x-agent-name': 'agent-1' },
      });
      // Re-claim C to get it out of the way
      await claimTask(idC, 'agent-1');
      await completeTask(idC, 'agent-1');

      // Reset A - it becomes pending but still depends on B (which is cycle)
      const resetRes = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${idA}/reset`,
      });
      assert.equal(resetRes.statusCode, 200);

      // Verify A is now pending
      const tAReset = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idA}` })).json();
      assert.equal(tAReset.status, 'pending');

      // claim-next should NOT return A (it still depends on B which is in cycle status)
      const claimAfterReset = await claimNext('agent-1');
      assert.equal(claimAfterReset.task, null, 'A should still be blocked by B which is in cycle status');
    });

    it('integrate-batch selectively integrates by agent', async () => {
      // Create two tasks
      const idT1 = await createTask('T1', 5);
      const idT2 = await createTask('T2', 5);

      // Agent-1 claims and completes T1
      await claimTask(idT1, 'agent-1');
      await completeTask(idT1, 'agent-1');

      // Agent-2 claims and completes T2
      await claimTask(idT2, 'agent-2');
      await completeTask(idT2, 'agent-2');

      // Integrate-batch for agent-1 only
      const batch1 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/integrate-batch',
        payload: { agent: 'agent-1' },
      });
      assert.equal(batch1.statusCode, 200);
      const batch1Body = batch1.json();
      assert.equal(batch1Body.ok, true);
      assert.equal(batch1Body.count, 1);
      assert.deepEqual(batch1Body.ids, [idT1]);

      // Verify T1 is integrated, T2 remains completed
      const t1After = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idT1}` })).json();
      const t2After = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idT2}` })).json();
      assert.equal(t1After.status, 'integrated');
      assert.equal(t2After.status, 'completed');

      // Integrate-batch for agent-2
      const batch2 = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/integrate-batch',
        payload: { agent: 'agent-2' },
      });
      assert.equal(batch2.statusCode, 200);
      const batch2Body = batch2.json();
      assert.equal(batch2Body.ok, true);
      assert.equal(batch2Body.count, 1);
      assert.deepEqual(batch2Body.ids, [idT2]);

      // Verify T2 is now also integrated
      const t2Final = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idT2}` })).json();
      assert.equal(t2Final.status, 'integrated');
    });
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
        });
      }

      const res = await ctx.app.inject({ method: 'GET', url: '/tasks' });
      assert.equal(res.statusCode, 200);
      const body = res.json() as any;
      assert.equal(body.tasks.length, 20);
      assert.equal(body.total, 25);
    });

    it('offset beyond total returns empty tasks array', async () => {
      for (let i = 0; i < 3; i++) {
        await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: `Task ${i + 1}` },
        });
      }

      const res = await ctx.app.inject({ method: 'GET', url: '/tasks?offset=100' });
      assert.equal(res.statusCode, 200);
      const body = res.json() as any;
      assert.equal(body.tasks.length, 0);
      assert.equal(body.total, 3);
    });

    it('negative offset is clamped to 0', async () => {
      await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'A' } });
      await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'B' } });

      const res = await ctx.app.inject({ method: 'GET', url: '/tasks?offset=-5' });
      assert.equal(res.statusCode, 200);
      const body = res.json() as any;
      assert.equal(body.tasks.length, 2);
      assert.equal(body.total, 2);
    });

    it('limit=0 is clamped to 1', async () => {
      await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'A' } });
      await ctx.app.inject({ method: 'POST', url: '/tasks', payload: { title: 'B' } });

      const res = await ctx.app.inject({ method: 'GET', url: '/tasks?limit=0' });
      assert.equal(res.statusCode, 200);
      const body = res.json() as any;
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
        });
      }

      // Create 2 tasks and complete them
      for (let i = 0; i < 2; i++) {
        const r = await ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          payload: { title: `Completed ${i + 1}` },
        });
        const id = r.json().id;
        await ctx.app.inject({
          method: 'POST',
          url: `/tasks/${id}/claim`,
          headers: { 'x-agent-name': 'agent-1' },
        });
        await ctx.app.inject({
          method: 'POST',
          url: `/tasks/${id}/complete`,
          payload: { result: { done: true } },
        });
      }

      // First page of pending: limit=2, offset=0
      const page1 = await ctx.app.inject({
        method: 'GET',
        url: '/tasks?status=pending&limit=2&offset=0',
      });
      assert.equal(page1.statusCode, 200);
      const body1 = page1.json() as any;
      assert.equal(body1.tasks.length, 2);
      assert.equal(body1.total, 3);

      // Second page of pending: limit=2, offset=2
      const page2 = await ctx.app.inject({
        method: 'GET',
        url: '/tasks?status=pending&limit=2&offset=2',
      });
      assert.equal(page2.statusCode, 200);
      const body2 = page2.json() as any;
      assert.equal(body2.tasks.length, 1);
      assert.equal(body2.total, 3);
    });
  });

  describe('x-agent-name validation', () => {
    it('POST /tasks/claim-next rejects malformed x-agent-name', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': '../../evil' },
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
      });
      const taskId = createRes.json().id;

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { 'x-agent-name': '../../evil' },
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
      });
      assert.equal(res.statusCode, 400);
      const body = res.json();
      assert.ok(body.message.includes('Invalid agent name in targetAgents'));
    });
  });
});
