import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, createTestConfig, type TestContext } from '../test-helper.js';
import tasksPlugin from './tasks.js';
import filesPlugin from './files.js';

describe('files routes', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
    const config = createTestConfig();
    await ctx.app.register(tasksPlugin, { config });
    await ctx.app.register(filesPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.cleanup();
  });

  it('GET /files returns all registered files', async () => {
    // Create tasks with files to populate the registry
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Task A', files: ['Source/Foo.cpp', 'Source/Bar.h'] },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Task B', files: ['Source/Bar.h', 'Source/Baz.cpp'] },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/files' });
    assert.equal(res.statusCode, 200);
    const files = res.json();
    const paths = files.map((f: { path: string }) => f.path);
    assert.equal(paths.length, 3);
    assert.ok(paths.includes('Source/Foo.cpp'));
    assert.ok(paths.includes('Source/Bar.h'));
    assert.ok(paths.includes('Source/Baz.cpp'));
  });

  it('GET /files?claimant=X filters by claimant', async () => {
    // All files start unclaimed, so filtering by claimant returns empty
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Task', files: ['Source/A.cpp'] },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/files?claimant=agent-1' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().length, 0);
  });

  it('GET /files?unclaimed=true returns only unclaimed files', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Task', files: ['Source/A.cpp', 'Source/B.cpp'] },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/files?unclaimed=true' });
    assert.equal(res.statusCode, 200);
    const files = res.json();
    assert.equal(files.length, 2);
    for (const f of files) {
      assert.equal(f.claimant, null);
    }
  });

  it('GET /files returns files with correct shape', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { title: 'Task', files: ['Source/X.cpp'] },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/files' });
    const file = res.json()[0];
    assert.equal(typeof file.path, 'string');
    assert.equal(file.claimant, null);
    assert.equal(file.claimedAt, null);
  });
});
