import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import { files } from '../schema/tables.js';
import filesPlugin from './files.js';

describe('files routes (drizzle)', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(filesPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  async function insertFile(path: string, claimant?: string | null) {
    await ctx.db.insert(files).values({
      projectId: 'default',
      path,
      claimant: claimant ?? null,
    });
  }

  it('GET /files returns all registered files', async () => {
    await insertFile('Source/Foo.cpp');
    await insertFile('Source/Bar.h');
    await insertFile('Source/Baz.cpp');

    const res = await ctx.app.inject({ method: 'GET', url: '/files' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    const paths = body.map((f: { path: string }) => f.path);
    assert.equal(paths.length, 3);
    assert.ok(paths.includes('Source/Foo.cpp'));
    assert.ok(paths.includes('Source/Bar.h'));
    assert.ok(paths.includes('Source/Baz.cpp'));
  });

  it('GET /files?claimant=X filters by claimant', async () => {
    await insertFile('Source/A.cpp');
    await insertFile('Source/B.cpp', 'agent-1');

    const res = await ctx.app.inject({ method: 'GET', url: '/files?claimant=agent-1' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].path, 'Source/B.cpp');
  });

  it('GET /files?unclaimed=true returns only unclaimed files', async () => {
    await insertFile('Source/A.cpp');
    await insertFile('Source/B.cpp');
    await insertFile('Source/C.cpp', 'agent-1');

    const res = await ctx.app.inject({ method: 'GET', url: '/files?unclaimed=true' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.length, 2);
    for (const f of body) {
      assert.equal(f.claimant, null);
    }
  });

  it('GET /files returns files with correct shape', async () => {
    await insertFile('Source/X.cpp');

    const res = await ctx.app.inject({ method: 'GET', url: '/files' });
    const file = res.json()[0];
    assert.equal(typeof file.path, 'string');
    assert.equal(file.claimant, null);
    assert.equal(file.claimedAt, null);
  });
});
