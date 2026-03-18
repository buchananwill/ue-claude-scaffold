import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, createTestConfig, type TestContext } from '../test-helper.js';
import { writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import buildPlugin from './build.js';
import { initUbtStatements } from './ubt.js';

describe('build routes', () => {
  let ctx: TestContext;
  let mockScriptPath: string;

  beforeEach(async () => {
    ctx = await createTestApp();

    // Create a mock build/test script (a node script that prints to stdout/stderr)
    mockScriptPath = path.join(ctx.tmpDir, 'mock-build.js');
    writeFileSync(
      mockScriptPath,
      `process.stdout.write('build output line\\n');
process.stderr.write('build warning\\n');
process.exit(0);
`
    );

    // initUbtStatements must be called since build.ts uses isStale which depends on ubt statements
    initUbtStatements();

    const config = createTestConfig({
      build: {
        scriptPath: `node ${mockScriptPath}`,
        testScriptPath: `node ${mockScriptPath}`,
        defaultTestFilters: ['TestFilter1'],
        buildTimeoutMs: 660_000,
        testTimeoutMs: 700_000,
      },
      server: {
        port: 9100,
        ubtLockTimeoutMs: 600000,
        stagingWorktreePath: ctx.tmpDir,
        bareRepoPath: ctx.tmpDir,
      },
    });

    await ctx.app.register(buildPlugin, { config });
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.cleanup();
  });

  it('POST /build returns the correct response shape', async () => {
    // syncWorktree will likely fail (no real git repo), so we test the shape
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/build',
      payload: {},
    });
    // We expect either a success response or a syncWorktree failure with the right shape
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(typeof body.success, 'boolean');
    assert.equal(typeof body.exit_code, 'number');
    assert.equal(typeof body.output, 'string');
    assert.equal(typeof body.stderr, 'string');
  });

  it('POST /test returns the correct response shape', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/test',
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(typeof body.success, 'boolean');
    assert.equal(typeof body.exit_code, 'number');
    assert.equal(typeof body.output, 'string');
    assert.equal(typeof body.stderr, 'string');
  });
});
