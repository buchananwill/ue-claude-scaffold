import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestApp, createTestConfig, type TestContext } from '../test-helper.js';
import tasksPlugin from './tasks.js';
import agentsPlugin from './agents.js';

/**
 * Tests for Phase 3 — Parallel Staging Worktrees.
 *
 * The path resolution functions (getStagingWorktree, getBareRepoPath) are
 * private inside the build and tasks plugins. We test them through:
 *
 * 1. Config shape validation — verifying the ScaffoldConfig type supports
 *    the new Root fields alongside legacy Path fields.
 *
 * 2. Path computation contract — the convention is:
 *      staging: <stagingWorktreeRoot>/<agentName>
 *      bare:    <bareRepoRoot>/<agentName>.git
 *    These path tests replicate the logic from build.ts and tasks.ts.
 *
 * 3. Tasks route integration — getBareRepoPath in tasks.ts is exercised
 *    during /tasks/:id/claim when sourcePath validation runs. We test
 *    various config shapes to ensure the claim path works correctly.
 */

// --- Helper: replicate the path resolution logic from build.ts ---
// This mirrors the exact implementation to verify the contract.

function getStagingWorktree(
  config: { stagingWorktreeRoot?: string; stagingWorktreePath?: string },
  projectPath: string,
  agentName: string | undefined,
): string {
  if (config.stagingWorktreeRoot && agentName) {
    return path.join(config.stagingWorktreeRoot, agentName);
  }
  return config.stagingWorktreePath ?? projectPath;
}

function getBareRepoPathBuild(
  config: { bareRepoRoot?: string; bareRepoPath?: string },
  projectPath: string,
  agentName: string | undefined,
): string {
  if (config.bareRepoRoot && agentName) {
    return path.join(config.bareRepoRoot, `${agentName}.git`);
  }
  return config.bareRepoPath ?? path.join(projectPath, '..', 'repo.git');
}

function getBareRepoPathTasks(
  config: { bareRepoRoot?: string; bareRepoPath?: string },
  agentName?: string,
): string | undefined {
  if (config.bareRepoRoot && agentName) {
    return path.join(config.bareRepoRoot, `${agentName}.git`);
  }
  return config.bareRepoPath;
}

describe('parallel worktrees — path resolution contract', () => {

  describe('getStagingWorktree', () => {
    it('returns <stagingWorktreeRoot>/<agentName> when root is set and agent provided', () => {
      const result = getStagingWorktree(
        { stagingWorktreeRoot: '/staging' },
        '/project',
        'agent-1',
      );
      assert.equal(result, path.join('/staging', 'agent-1'));
    });

    it('two agents get different staging worktree paths', () => {
      const config = { stagingWorktreeRoot: '/staging' };
      const path1 = getStagingWorktree(config, '/project', 'agent-1');
      const path2 = getStagingWorktree(config, '/project', 'agent-2');
      assert.notEqual(path1, path2);
      assert.equal(path1, path.join('/staging', 'agent-1'));
      assert.equal(path2, path.join('/staging', 'agent-2'));
    });

    it('falls back to stagingWorktreePath when root is not set', () => {
      const result = getStagingWorktree(
        { stagingWorktreePath: '/legacy/staging' },
        '/project',
        'agent-1',
      );
      assert.equal(result, '/legacy/staging');
    });

    it('falls back to stagingWorktreePath when agentName is undefined', () => {
      const result = getStagingWorktree(
        { stagingWorktreeRoot: '/staging', stagingWorktreePath: '/legacy/staging' },
        '/project',
        undefined,
      );
      assert.equal(result, '/legacy/staging');
    });

    it('falls back to project.path when neither root nor path is set', () => {
      const result = getStagingWorktree({}, '/my/project', undefined);
      assert.equal(result, '/my/project');
    });

    it('falls back to project.path when root is set but no agent name', () => {
      const result = getStagingWorktree(
        { stagingWorktreeRoot: '/staging' },
        '/my/project',
        undefined,
      );
      assert.equal(result, '/my/project');
    });
  });

  describe('getBareRepoPath (build route variant)', () => {
    it('returns <bareRepoRoot>/<agentName>.git when root is set and agent provided', () => {
      const result = getBareRepoPathBuild(
        { bareRepoRoot: '/bare-repos' },
        '/project',
        'agent-1',
      );
      assert.equal(result, path.join('/bare-repos', 'agent-1.git'));
    });

    it('two agents get different bare repo paths', () => {
      const config = { bareRepoRoot: '/bare-repos' };
      const path1 = getBareRepoPathBuild(config, '/project', 'agent-1');
      const path2 = getBareRepoPathBuild(config, '/project', 'agent-2');
      assert.notEqual(path1, path2);
    });

    it('falls back to bareRepoPath when root is not set', () => {
      const result = getBareRepoPathBuild(
        { bareRepoPath: '/legacy/repo.git' },
        '/project',
        'agent-1',
      );
      assert.equal(result, '/legacy/repo.git');
    });

    it('falls back to bareRepoPath when agentName is undefined', () => {
      const result = getBareRepoPathBuild(
        { bareRepoRoot: '/bare-repos', bareRepoPath: '/legacy/repo.git' },
        '/project',
        undefined,
      );
      assert.equal(result, '/legacy/repo.git');
    });

    it('falls back to <project.path>/../repo.git when nothing is set', () => {
      const result = getBareRepoPathBuild({}, '/my/project', undefined);
      assert.equal(result, path.join('/my/project', '..', 'repo.git'));
    });
  });

  describe('getBareRepoPath (tasks route variant)', () => {
    it('returns <bareRepoRoot>/<agentName>.git when root is set and agent provided', () => {
      const result = getBareRepoPathTasks(
        { bareRepoRoot: '/bare-repos' },
        'agent-1',
      );
      assert.equal(result, path.join('/bare-repos', 'agent-1.git'));
    });

    it('returns bareRepoPath when root is not set', () => {
      const result = getBareRepoPathTasks(
        { bareRepoPath: '/legacy/repo.git' },
        'agent-1',
      );
      assert.equal(result, '/legacy/repo.git');
    });

    it('returns undefined when neither root nor path is set', () => {
      const result = getBareRepoPathTasks({});
      assert.equal(result, undefined);
    });

    it('returns bareRepoPath when agentName is undefined', () => {
      const result = getBareRepoPathTasks(
        { bareRepoRoot: '/bare-repos', bareRepoPath: '/fallback.git' },
        undefined,
      );
      assert.equal(result, '/fallback.git');
    });
  });
});

describe('parallel worktrees — config shape', () => {
  it('ScaffoldConfig supports stagingWorktreeRoot and bareRepoRoot fields', () => {
    const config = createTestConfig({
      server: {
        port: 9100,
        ubtLockTimeoutMs: 600000,
        stagingWorktreeRoot: '/staging',
        bareRepoRoot: '/bare-repos',
      },
    });

    assert.equal(config.server.stagingWorktreeRoot, '/staging');
    assert.equal(config.server.bareRepoRoot, '/bare-repos');
    assert.equal(config.server.stagingWorktreePath, undefined);
    assert.equal(config.server.bareRepoPath, undefined);
  });

  it('ScaffoldConfig supports legacy single-worktree fields', () => {
    const config = createTestConfig({
      server: {
        port: 9100,
        ubtLockTimeoutMs: 600000,
        stagingWorktreePath: '/single/staging',
        bareRepoPath: '/single/repo.git',
      },
    });

    assert.equal(config.server.stagingWorktreePath, '/single/staging');
    assert.equal(config.server.bareRepoPath, '/single/repo.git');
    assert.equal(config.server.stagingWorktreeRoot, undefined);
    assert.equal(config.server.bareRepoRoot, undefined);
  });

  it('ScaffoldConfig supports both Root and Path fields simultaneously', () => {
    const config = createTestConfig({
      server: {
        port: 9100,
        ubtLockTimeoutMs: 600000,
        stagingWorktreeRoot: '/staging',
        bareRepoRoot: '/bare-repos',
        stagingWorktreePath: '/fallback/staging',
        bareRepoPath: '/fallback/repo.git',
      },
    });

    assert.equal(config.server.stagingWorktreeRoot, '/staging');
    assert.equal(config.server.bareRepoRoot, '/bare-repos');
    assert.equal(config.server.stagingWorktreePath, '/fallback/staging');
    assert.equal(config.server.bareRepoPath, '/fallback/repo.git');
  });
});

describe('parallel worktrees — tasks route integration', () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.app.close();
    ctx.cleanup();
  });

  it('claim succeeds with per-agent bareRepoRoot config (no sourcePath)', async () => {
    ctx = await createTestApp();

    const config = createTestConfig({
      server: {
        port: 9100,
        ubtLockTimeoutMs: 600000,
        bareRepoRoot: '/bare-repos',
      },
    });

    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(tasksPlugin, { config });

    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: 'branch-1' },
    });

    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Test per-agent bare repo' },
    });
    const taskId = createRes.json().id;

    // Claim succeeds because source_path is null, so bare repo validation is skipped
    const claimRes = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });
    assert.equal(claimRes.statusCode, 200);
    assert.deepEqual(claimRes.json(), { ok: true });
  });

  it('claim succeeds with legacy bareRepoPath config (no sourcePath)', async () => {
    ctx = await createTestApp();

    const config = createTestConfig({
      server: {
        port: 9100,
        ubtLockTimeoutMs: 600000,
        bareRepoPath: '/legacy/repo.git',
      },
    });

    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(tasksPlugin, { config });

    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: 'branch-1' },
    });

    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Legacy config test' },
    });
    const taskId = createRes.json().id;

    const claimRes = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });
    assert.equal(claimRes.statusCode, 200);
    assert.deepEqual(claimRes.json(), { ok: true });
  });

  it('claim succeeds when neither bareRepoRoot nor bareRepoPath is set', async () => {
    ctx = await createTestApp();

    const config = createTestConfig({
      server: {
        port: 9100,
        ubtLockTimeoutMs: 600000,
      },
    });

    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(tasksPlugin, { config });

    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: 'branch-1' },
    });

    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'No bare repo config' },
    });
    const taskId = createRes.json().id;

    // getBareRepoPath returns undefined => sourcePath validation skipped
    const claimRes = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });
    assert.equal(claimRes.statusCode, 200);
    assert.deepEqual(claimRes.json(), { ok: true });
  });

  it('two agents can independently claim different tasks with per-agent config', async () => {
    ctx = await createTestApp();

    const config = createTestConfig({
      server: {
        port: 9100,
        ubtLockTimeoutMs: 600000,
        bareRepoRoot: '/bare-repos',
        stagingWorktreeRoot: '/staging',
      },
    });

    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(tasksPlugin, { config });

    // Register two agents
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: 'branch-1' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-2', worktree: 'branch-2' },
    });

    // Create two tasks with non-overlapping files
    const t1 = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Task for agent-1', files: ['ModuleA/Foo.cpp'] },
    });
    const t2 = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Task for agent-2', files: ['ModuleB/Bar.cpp'] },
    });
    const id1 = t1.json().id;
    const id2 = t2.json().id;

    // Both agents claim their tasks successfully
    const claim1 = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id1}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });
    assert.equal(claim1.statusCode, 200);

    const claim2 = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id2}/claim`,
      headers: { 'x-agent-name': 'agent-2' },
    });
    assert.equal(claim2.statusCode, 200);

    // Verify each task is claimed by the correct agent
    const get1 = await ctx.app.inject({ method: 'GET', url: `/tasks/${id1}` });
    assert.equal(get1.json().claimedBy, 'agent-1');

    const get2 = await ctx.app.inject({ method: 'GET', url: `/tasks/${id2}` });
    assert.equal(get2.json().claimedBy, 'agent-2');
  });

  it('agent cannot claim task with overlapping files owned by another agent', async () => {
    ctx = await createTestApp();

    const config = createTestConfig({
      server: {
        port: 9100,
        ubtLockTimeoutMs: 600000,
        bareRepoRoot: '/bare-repos',
        stagingWorktreeRoot: '/staging',
      },
    });

    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(tasksPlugin, { config });

    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: 'branch-1' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-2', worktree: 'branch-2' },
    });

    // Task 1: agent-1 claims it, locking Shared.cpp
    const t1 = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Agent-1 task', files: ['Shared.cpp'] },
    });
    const id1 = t1.json().id;
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id1}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });

    // Task 2: overlaps on Shared.cpp — agent-2 should be blocked
    const t2 = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Agent-2 blocked', files: ['Shared.cpp'] },
    });
    const id2 = t2.json().id;

    const claim2 = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${id2}/claim`,
      headers: { 'x-agent-name': 'agent-2' },
    });
    assert.equal(claim2.statusCode, 409);
    const body = claim2.json();
    assert.ok(body.conflicts);
    assert.equal(body.conflicts[0].file, 'Shared.cpp');
    assert.equal(body.conflicts[0].claimant, 'agent-1');
  });

  it('claim-next with per-agent config routes around file conflicts', async () => {
    ctx = await createTestApp();

    const config = createTestConfig({
      server: {
        port: 9100,
        ubtLockTimeoutMs: 600000,
        bareRepoRoot: '/bare-repos',
        stagingWorktreeRoot: '/staging',
      },
    });

    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(tasksPlugin, { config });

    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: 'branch-1' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-2', worktree: 'branch-2' },
    });

    // Agent-1 claims a task with Shared.cpp
    const t1 = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Agent-1 owns Shared', files: ['Shared.cpp'] },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${t1.json().id}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });

    // Create two more pending tasks: one overlapping, one free
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Blocked for agent-2', files: ['Shared.cpp'] },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Free for agent-2', files: ['Other.cpp'] },
    });

    // Agent-2 claim-next should get the free task
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/claim-next',
      headers: { 'x-agent-name': 'agent-2' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().task.title, 'Free for agent-2');
  });
});
