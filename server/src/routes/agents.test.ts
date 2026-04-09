import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import { createTestConfig } from '../test-helper.js';
import { tasks, agents } from '../schema/tables.js';
import { eq, sql } from 'drizzle-orm';
import agentsPlugin from './agents.js';

describe('agents routes (drizzle)', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(agentsPlugin, { config: createTestConfig() });
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
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
    const regBody = reg.json();
    assert.equal(regBody.ok, true);
    assert.ok(typeof regBody.sessionToken === 'string', 'sessionToken is returned');
    assert.ok(typeof regBody.id === 'string', 'id is returned');

    const list = await ctx.app.inject({ method: 'GET', url: '/agents' });
    const agentsList = list.json();
    assert.equal(agentsList.length, 1);
    assert.equal(agentsList[0].name, 'agent-1');
    assert.equal(agentsList[0].worktree, '/tmp/wt1');
    assert.equal(agentsList[0].planDoc, 'plan.md');
    assert.equal(agentsList[0].status, 'idle');
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
    const agentsList = list.json();
    assert.equal(agentsList.length, 1);
    assert.equal(agentsList[0].worktree, '/tmp/wt2');
  });

  it('POST /agents/:name/status updates status with a valid value', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/agent-1/status',
      payload: { status: 'working' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });

    const list = await ctx.app.inject({ method: 'GET', url: '/agents' });
    assert.equal(list.json()[0].status, 'working');
  });

  it('POST /agents/:name/status rejects invalid status values', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/agent-1/status',
      payload: { status: 'banana' },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error, 'invalid_status');
    assert.ok(Array.isArray(body.allowed));
  });

  it('POST /agents/:name/status rejects deleted status', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/agent-1/status',
      payload: { status: 'deleted' },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error, 'invalid_status');
  });

  it('POST /agents/:name/status for non-existent agent returns 404', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/no-such-agent/status',
      payload: { status: 'working' },
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

  it('DELETE /agents/:name soft-deletes (sets status to deleted)', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    const del = await ctx.app.inject({ method: 'DELETE', url: '/agents/agent-1' });
    assert.equal(del.statusCode, 200);
    assert.deepEqual(del.json(), { ok: true, deleted: true });

    // Agent should still exist with status 'deleted'
    const row = await ctx.db.select().from(agents).where(eq(agents.name, 'agent-1'));
    assert.equal(row.length, 1);
    assert.equal(row[0].status, 'deleted');
  });

  it('DELETE /agents/:name returns 404 for unknown agent', async () => {
    const del = await ctx.app.inject({ method: 'DELETE', url: '/agents/ghost' });
    assert.equal(del.statusCode, 404);
  });

  it('DELETE /agents/:name with valid sessionToken succeeds', async () => {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });
    const { sessionToken } = reg.json();

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/agents/agent-1?sessionToken=${sessionToken}`,
    });
    assert.equal(del.statusCode, 200);
    assert.deepEqual(del.json(), { ok: true, deleted: true });
  });

  it('DELETE /agents/:name with mismatched sessionToken returns 409', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/agents/agent-1?sessionToken=wrong-token-value',
    });
    assert.equal(del.statusCode, 409);
    const body = del.json();
    assert.ok(body.error.includes('session token mismatch'));
  });

  it('DELETE /agents/:name without sessionToken skips the check', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    const del = await ctx.app.inject({ method: 'DELETE', url: '/agents/agent-1' });
    assert.equal(del.statusCode, 200);
    assert.deepEqual(del.json(), { ok: true, deleted: true });
  });

  it('POST /agents/register with mode pump returns mode pump', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'pump-agent', worktree: '/tmp/wt1', mode: 'pump' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/agents/pump-agent' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().mode, 'pump');
  });

  it('POST /agents/register without mode defaults to single', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'default-agent', worktree: '/tmp/wt1' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/agents/default-agent' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().mode, 'single');
  });

  it('DELETE /agents soft-deletes all agents for the project', async () => {
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
    assert.equal(del.json().deletedCount, 2);

    // Both agents still exist in DB with status 'deleted'
    const rows = await ctx.db.select().from(agents);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.status, 'deleted');
    }
  });
});

describe('POST /agents/:name/sync (drizzle)', () => {
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

  function writeFileToBranch(repo: string, branch: string, filePath: string, content: string): string {
    const blobResult = spawnSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], {
      input: content, encoding: 'utf-8', timeout: 5000,
    });
    const blobSha = blobResult.stdout.trim();
    const parentSha = execSync(`git -C "${repo}" rev-parse refs/heads/${branch}`, { encoding: 'utf-8' }).trim();
    const treeEntry = `100644 blob ${blobSha}\t${filePath}\n`;
    const mkTree = spawnSync('git', ['-C', repo, 'mktree'], {
      input: treeEntry, encoding: 'utf-8', timeout: 5000,
    });
    const treeSha = mkTree.stdout.trim();
    const commitSha = execSync(`git -C "${repo}" commit-tree ${treeSha} -p ${parentSha} -m "add ${filePath}"`, { encoding: 'utf-8' }).trim();
    execSync(`git -C "${repo}" update-ref refs/heads/${branch} ${commitSha}`);
    return commitSha;
  }

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-sync-test-'));
    const { repo, initSha } = initBareRepoWithBranch(tmpDir, 'docker/default/current-root');
    tmpBareRepo = repo;

    // Create agent branch from the same initial commit
    execSync(`git -C "${tmpBareRepo}" update-ref refs/heads/docker/default/test-agent ${initSha}`);

    const config = createTestConfig({
      server: { port: 9100, ubtLockTimeoutMs: 600000, bareRepoPath: tmpBareRepo },
    });
    await ctx.app.register(agentsPlugin, { config });
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it('returns 404 when agent not found', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/nonexistent/sync',
    });
    assert.equal(res.statusCode, 404);
  });

  it('merges docker/default/current-root into docker/default/{name}', async () => {
    // Register the agent
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'test-agent', worktree: '/tmp/wt1' },
    });

    // Add a file to docker/default/current-root so there is something to merge
    writeFileToBranch(tmpBareRepo, 'docker/default/current-root', 'plan.md', '# Plan');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/test-agent/sync',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.ok(body.commitSha);

    // Verify the file is now on docker/default/test-agent
    const content = execSync(`git -C "${tmpBareRepo}" show docker/default/test-agent:plan.md`, { encoding: 'utf-8' });
    assert.equal(content, '# Plan');
  });

  it('returns 409 when target branch does not exist', async () => {
    // Register agent but do NOT create docker/no-branch branch
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'no-branch', worktree: '/tmp/wt1' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/no-branch/sync',
    });
    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.ok(body.reason.includes('does not exist'));
  });

  it('returns ok true with no commitSha when already up to date', async () => {
    // Register the agent
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'test-agent', worktree: '/tmp/wt1' },
    });

    // Both branches at same commit, nothing to merge
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/test-agent/sync',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.commitSha, undefined);
  });
});

describe('DELETE /agents task release (drizzle)', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    const config = createTestConfig();
    await ctx.app.register(agentsPlugin, { config });
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  /** Register an agent and return its UUID */
  async function registerAgent(name: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name, worktree: '/tmp/wt1' },
    });
    return res.json().id;
  }

  /** Create a task directly via DB */
  async function createTask(title: string, status: string = 'pending', claimedByAgentId: string | null = null): Promise<number> {
    const rows = await ctx.db.insert(tasks).values({
      title,
      status,
      claimedByAgentId,
      claimedAt: claimedByAgentId ? sql`now()` : null,
      projectId: 'default',
    }).returning();
    return rows[0].id;
  }

  /** Get task by id from DB */
  async function getTask(id: number) {
    const rows = await ctx.db.select().from(tasks).where(eq(tasks.id, id));
    return rows[0];
  }

  it('DELETE /agents/:name releases claimed tasks to pending', async () => {
    const agentId = await registerAgent('agent-1');
    const taskId = await createTask('task-1', 'claimed', agentId);

    // Verify task is claimed
    const before = await getTask(taskId);
    assert.equal(before.status, 'claimed');
    assert.equal(before.claimedByAgentId, agentId);

    // DELETE soft-deletes and releases tasks
    const del = await ctx.app.inject({ method: 'DELETE', url: '/agents/agent-1' });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().deleted, true);

    // Verify task reverted to pending with no claimant
    const after = await getTask(taskId);
    assert.equal(after.status, 'pending');
    assert.equal(after.claimedByAgentId, null);
  });

  it('DELETE /agents (bulk) releases claimed tasks to pending', async () => {
    const agentId = await registerAgent('agent-1');
    const taskId = await createTask('bulk-task', 'claimed', agentId);

    // Bulk DELETE all agents
    const del = await ctx.app.inject({ method: 'DELETE', url: '/agents' });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().ok, true);

    // Verify task reverted to pending
    const after = await getTask(taskId);
    assert.equal(after.status, 'pending');
    assert.equal(after.claimedByAgentId, null);
  });

  it('DELETE /agents/:name releases in_progress tasks to pending', async () => {
    const agentId = await registerAgent('agent-1');
    const taskId = await createTask('in-progress-task', 'in_progress', agentId);

    // Verify task is in_progress
    const before = await getTask(taskId);
    assert.equal(before.status, 'in_progress');
    assert.equal(before.claimedByAgentId, agentId);

    // DELETE soft-deletes and releases tasks
    const del = await ctx.app.inject({ method: 'DELETE', url: '/agents/agent-1' });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().deleted, true);

    // Verify task reverted to pending with no claimant
    const after = await getTask(taskId);
    assert.equal(after.status, 'pending');
    assert.equal(after.claimedByAgentId, null);
  });
});
