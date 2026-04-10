import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import { createTestConfig } from '../test-helper.js';
import { tasks, agents, projects } from '../schema/tables.js';
import { eq, and, sql } from 'drizzle-orm';
import agentsPlugin from './agents.js';

const PROJECT_ALPHA = 'alpha';
const PROJECT_BETA = 'beta';

/** Ensure a project row exists so the FK on agents is satisfied. */
async function ensureProject(ctx: DrizzleTestContext, id: string) {
  await ctx.db.insert(projects).values({ id, name: `Project ${id}` }).onConflictDoNothing();
}

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
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  });

  it('POST /agents/register creates an agent, GET /agents returns it', async () => {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'agent-1', worktree: '/tmp/wt1', planDoc: 'plan.md' },
    });
    assert.equal(reg.statusCode, 200);
    const regBody = reg.json();
    assert.equal(regBody.ok, true);
    assert.ok(typeof regBody.sessionToken === 'string', 'sessionToken is returned');
    assert.ok(typeof regBody.id === 'string', 'id is returned');

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/agents',
      headers: { 'x-project-id': 'default' },
    });
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
      headers: { 'x-project-id': 'default' },
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'agent-1', worktree: '/tmp/wt2' },
    });

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/agents',
      headers: { 'x-project-id': 'default' },
    });
    const agentsList = list.json();
    assert.equal(agentsList.length, 1);
    assert.equal(agentsList[0].worktree, '/tmp/wt2');
  });

  it('POST /agents/:name/status updates status with a valid value', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/agent-1/status',
      headers: { 'x-project-id': 'default' },
      payload: { status: 'working' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/agents',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(list.json()[0].status, 'working');
  });

  it('POST /agents/:name/status rejects invalid status values', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/agent-1/status',
      headers: { 'x-project-id': 'default' },
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
      headers: { 'x-project-id': 'default' },
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/agent-1/status',
      headers: { 'x-project-id': 'default' },
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
      headers: { 'x-project-id': 'default' },
      payload: { status: 'working' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('GET /agents/:name returns a single agent', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'agent-1', worktree: '/tmp/wt1', planDoc: 'plan.md' },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/agent-1',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 200);
    const agent = res.json();
    assert.equal(agent.name, 'agent-1');
    assert.equal(agent.worktree, '/tmp/wt1');
    assert.equal(agent.planDoc, 'plan.md');
    assert.equal(agent.status, 'idle');
    assert.ok(agent.registeredAt);
  });

  it('GET /agents/:name returns 404 for nonexistent agent', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/nonexistent',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('DELETE /agents/:name soft-deletes (sets status to deleted)', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/agents/agent-1',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(del.statusCode, 200);
    assert.deepEqual(del.json(), { ok: true, deleted: true });

    // Agent should still exist with status 'deleted'
    const row = await ctx.db
      .select()
      .from(agents)
      .where(and(eq(agents.name, 'agent-1'), eq(agents.projectId, 'default')));
    assert.equal(row.length, 1);
    assert.equal(row[0].status, 'deleted');
  });

  it('DELETE /agents/:name returns 404 for unknown agent', async () => {
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/agents/ghost',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(del.statusCode, 404);
  });

  it('DELETE /agents/:name with valid sessionToken succeeds', async () => {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });
    const { sessionToken } = reg.json();

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/agents/agent-1?sessionToken=${sessionToken}`,
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(del.statusCode, 200);
    assert.deepEqual(del.json(), { ok: true, deleted: true });
  });

  it('DELETE /agents/:name with mismatched sessionToken returns 409', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/agents/agent-1?sessionToken=wrong-token-value',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(del.statusCode, 409);
    const body = del.json();
    assert.ok(body.error.includes('session token mismatch'));
  });

  it('DELETE /agents/:name without sessionToken skips the check', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/agents/agent-1',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(del.statusCode, 200);
    assert.deepEqual(del.json(), { ok: true, deleted: true });
  });

  it('POST /agents/register with mode pump returns mode pump', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'pump-agent', worktree: '/tmp/wt1', mode: 'pump' },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/pump-agent',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().mode, 'pump');
  });

  it('GET /agents/:name returns 404 for agent in a different project', async () => {
    await ensureProject(ctx, 'proj-a');
    await ensureProject(ctx, 'proj-b');

    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'proj-a' },
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/agent-1',
      headers: { 'x-project-id': 'proj-b' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('DELETE /agents called twice returns deletedCount 0 on second call', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    const first = await ctx.app.inject({
      method: 'DELETE',
      url: '/agents',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().deletedCount, 1);

    const second = await ctx.app.inject({
      method: 'DELETE',
      url: '/agents',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json(), { ok: true, deletedCount: 0 });
  });

  it('POST /agents/register without mode defaults to single', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'default-agent', worktree: '/tmp/wt1' },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/default-agent',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().mode, 'single');
  });

  it('DELETE /agents soft-deletes all agents for the project', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'agent-2', worktree: '/tmp/wt2' },
    });

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/agents',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().ok, true);
    assert.equal(del.json().deletedCount, 2);

    // Both agents still exist in DB with status 'deleted'
    const rows = await ctx.db.select().from(agents).where(eq(agents.projectId, 'default'));
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.status, 'deleted');
    }
  });
});

describe('schema hardening V2.5 regressions', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(agentsPlugin, { config: createTestConfig() });
    await ensureProject(ctx, PROJECT_ALPHA);
    await ensureProject(ctx, PROJECT_BETA);
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it('cross-project coexistence: same agent name in two projects', async () => {
    const regAlpha = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': PROJECT_ALPHA },
      payload: { name: 'agent-1', worktree: '/tmp/wt-a' },
    });
    const regBeta = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': PROJECT_BETA },
      payload: { name: 'agent-1', worktree: '/tmp/wt-b' },
    });

    assert.equal(regAlpha.statusCode, 200);
    assert.equal(regBeta.statusCode, 200);

    const alphaId = regAlpha.json().id;
    const betaId = regBeta.json().id;
    assert.notEqual(alphaId, betaId, 'distinct UUIDs across projects');

    // Verify DB rows have correct project_id
    const alphaRows = await ctx.db.select().from(agents).where(and(eq(agents.id, alphaId)));
    assert.equal(alphaRows[0].projectId, PROJECT_ALPHA);
    const betaRows = await ctx.db.select().from(agents).where(and(eq(agents.id, betaId)));
    assert.equal(betaRows[0].projectId, PROJECT_BETA);

    // GET scoped by project
    const getAlpha = await ctx.app.inject({
      method: 'GET',
      url: '/agents/agent-1',
      headers: { 'x-project-id': PROJECT_ALPHA },
    });
    assert.equal(getAlpha.statusCode, 200);
    assert.equal(getAlpha.json().projectId, PROJECT_ALPHA);

    const getBeta = await ctx.app.inject({
      method: 'GET',
      url: '/agents/agent-1',
      headers: { 'x-project-id': PROJECT_BETA },
    });
    assert.equal(getBeta.statusCode, 200);
    assert.equal(getBeta.json().projectId, PROJECT_BETA);
  });

  it('cross-project DELETE isolation: deleting in alpha does not affect beta tasks', async () => {
    // Register agent-1 in both projects
    const regAlpha = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': PROJECT_ALPHA },
      payload: { name: 'agent-1', worktree: '/tmp/wt-a' },
    });
    const regBeta = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': PROJECT_BETA },
      payload: { name: 'agent-1', worktree: '/tmp/wt-b' },
    });
    const betaAgentId = regBeta.json().id;

    // Claim a task in project beta
    const taskRows = await ctx.db.insert(tasks).values({
      title: 'beta-task',
      status: 'in_progress',
      claimedByAgentId: betaAgentId,
      claimedAt: sql`now()`,
      projectId: PROJECT_BETA,
    }).returning();
    const taskId = taskRows[0].id;

    // DELETE agent-1 in alpha
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/agents/agent-1',
      headers: { 'x-project-id': PROJECT_ALPHA },
    });
    assert.equal(del.statusCode, 200);

    // Alpha's agent should be deleted
    const alphaRow = await ctx.db.select().from(agents)
      .where(and(eq(agents.name, 'agent-1'), eq(agents.projectId, PROJECT_ALPHA)));
    assert.equal(alphaRow[0].status, 'deleted');

    // Beta's agent should be untouched
    const betaRow = await ctx.db.select().from(agents)
      .where(and(eq(agents.name, 'agent-1'), eq(agents.projectId, PROJECT_BETA)));
    assert.equal(betaRow[0].status, 'idle');

    // Task in beta should still be in_progress with same claimant
    const task = await ctx.db.select().from(tasks).where(eq(tasks.id, taskId));
    assert.equal(task[0].status, 'in_progress');
    assert.equal(task[0].claimedByAgentId, betaAgentId);
  });

  it('session token mismatch returns 409; omitting token allows deletion', async () => {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': PROJECT_ALPHA },
      payload: { name: 'agent-1', worktree: '/tmp/wt-a' },
    });
    const { sessionToken } = reg.json();
    assert.ok(sessionToken);

    // Wrong token => 409
    const badDel = await ctx.app.inject({
      method: 'DELETE',
      url: '/agents/agent-1?sessionToken=deadbeef00000000deadbeef00000000',
      headers: { 'x-project-id': PROJECT_ALPHA },
    });
    assert.equal(badDel.statusCode, 409);

    // No token => 200, status deleted
    const goodDel = await ctx.app.inject({
      method: 'DELETE',
      url: '/agents/agent-1',
      headers: { 'x-project-id': PROJECT_ALPHA },
    });
    assert.equal(goodDel.statusCode, 200);
    const row = await ctx.db.select().from(agents)
      .where(and(eq(agents.name, 'agent-1'), eq(agents.projectId, PROJECT_ALPHA)));
    assert.equal(row[0].status, 'deleted');

    // Second DELETE without token is idempotent — agent already deleted but still exists
    // The route looks up via getByNameFull which still finds the row, then softDelete is a no-op
    const secondDel = await ctx.app.inject({
      method: 'DELETE',
      url: '/agents/agent-1',
      headers: { 'x-project-id': PROJECT_ALPHA },
    });
    assert.equal(secondDel.statusCode, 200);
  });

  it('reactivation: re-register after soft-delete preserves id, rotates token', async () => {
    const reg1 = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': PROJECT_ALPHA },
      payload: { name: 'agent-1', worktree: '/tmp/wt-a' },
    });
    const { id: originalId, sessionToken: token1 } = reg1.json();

    // Soft-delete
    await ctx.app.inject({
      method: 'DELETE',
      url: '/agents/agent-1',
      headers: { 'x-project-id': PROJECT_ALPHA },
    });

    // Re-register
    const reg2 = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': PROJECT_ALPHA },
      payload: { name: 'agent-1', worktree: '/tmp/wt-a-v2' },
    });
    assert.equal(reg2.statusCode, 200);
    const { id: reactivatedId, sessionToken: token2 } = reg2.json();

    // Same UUID (upsert, not new row)
    assert.equal(reactivatedId, originalId);

    // Token rotated
    assert.notEqual(token2, token1);

    // Status back to idle
    const getRes = await ctx.app.inject({
      method: 'GET',
      url: '/agents/agent-1',
      headers: { 'x-project-id': PROJECT_ALPHA },
    });
    assert.equal(getRes.json().status, 'idle');
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
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('merges docker/default/current-root into docker/default/{name}', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'test-agent', worktree: '/tmp/wt1' },
    });

    writeFileToBranch(tmpBareRepo, 'docker/default/current-root', 'plan.md', '# Plan');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/test-agent/sync',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.ok(body.commitSha);

    const content = execSync(`git -C "${tmpBareRepo}" show docker/default/test-agent:plan.md`, { encoding: 'utf-8' });
    assert.equal(content, '# Plan');
  });

  it('returns 409 when target branch does not exist', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'no-branch', worktree: '/tmp/wt1' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/no-branch/sync',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.ok(body.reason.includes('does not exist'));
  });

  it('returns ok true with no commitSha when already up to date', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'test-agent', worktree: '/tmp/wt1' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/test-agent/sync',
      headers: { 'x-project-id': 'default' },
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
      headers: { 'x-project-id': 'default' },
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

    const before = await getTask(taskId);
    assert.equal(before.status, 'claimed');
    assert.equal(before.claimedByAgentId, agentId);

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/agents/agent-1',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().deleted, true);

    const after = await getTask(taskId);
    assert.equal(after.status, 'pending');
    assert.equal(after.claimedByAgentId, null);
  });

  it('DELETE /agents (bulk) releases claimed tasks to pending', async () => {
    const agentId = await registerAgent('agent-1');
    const taskId = await createTask('bulk-task', 'claimed', agentId);

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/agents',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().ok, true);

    const after = await getTask(taskId);
    assert.equal(after.status, 'pending');
    assert.equal(after.claimedByAgentId, null);
  });

  it('DELETE /agents/:name releases in_progress tasks to pending', async () => {
    const agentId = await registerAgent('agent-1');
    const taskId = await createTask('in-progress-task', 'in_progress', agentId);

    const before = await getTask(taskId);
    assert.equal(before.status, 'in_progress');
    assert.equal(before.claimedByAgentId, agentId);

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/agents/agent-1',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().deleted, true);

    const after = await getTask(taskId);
    assert.equal(after.status, 'pending');
    assert.equal(after.claimedByAgentId, null);
  });
});
