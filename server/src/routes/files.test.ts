import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import { createTestConfig } from '../test-helper.js';
import { files, agents } from '../schema/tables.js';
import { eq, and } from 'drizzle-orm';
import filesPlugin from './files.js';
import agentsPlugin from './agents.js';

describe('files routes (drizzle)', () => {
  let ctx: DrizzleTestContext;
  let agent1Id: string;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(agentsPlugin, { config: createTestConfig() });
    await ctx.app.register(filesPlugin);

    // Register an agent via route to get a UUID
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });
    agent1Id = reg.json().id;
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  async function insertFile(path: string, claimantAgentId?: string | null) {
    await ctx.db.insert(files).values({
      projectId: 'default',
      path,
      claimantAgentId: claimantAgentId ?? null,
    });
  }

  it('GET /files returns all registered files', async () => {
    await insertFile('Source/Foo.cpp');
    await insertFile('Source/Bar.h');
    await insertFile('Source/Baz.cpp');

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/files',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    const paths = body.map((f: { path: string }) => f.path);
    assert.equal(paths.length, 3);
    assert.ok(paths.includes('Source/Foo.cpp'));
    assert.ok(paths.includes('Source/Bar.h'));
    assert.ok(paths.includes('Source/Baz.cpp'));
  });

  it('GET /files?claimant=X filters by claimant (resolved from agent name)', async () => {
    await insertFile('Source/A.cpp');
    await insertFile('Source/B.cpp', agent1Id);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/files?claimant=agent-1',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].path, 'Source/B.cpp');
  });

  it('GET /files?unclaimed=true returns only unclaimed files', async () => {
    await insertFile('Source/A.cpp');
    await insertFile('Source/B.cpp');
    await insertFile('Source/C.cpp', agent1Id);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/files?unclaimed=true',
      headers: { 'x-project-id': 'default' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.length, 2);
    for (const f of body) {
      assert.equal(f.claimant, null);
    }
  });

  it('GET /files returns files with correct shape', async () => {
    await insertFile('Source/X.cpp');

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/files',
      headers: { 'x-project-id': 'default' },
    });
    const file = res.json()[0];
    assert.equal(typeof file.path, 'string');
    assert.equal(file.claimant, null);
    assert.equal(file.claimedAt, null);
  });
});
