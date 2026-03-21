import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, createTestConfig, type TestContext } from '../test-helper.js';
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import buildPlugin from './build.js';
import agentsPlugin from './agents.js';
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
        ubtRetryCount: 5,
        ubtRetryDelayMs: 30_000,
      },
      server: {
        port: 9100,
        ubtLockTimeoutMs: 600000,
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

describe('build route branch resolution', () => {
  let ctx: TestContext;
  let mockScriptPath: string;
  let stagingRoot: string;
  let projectPath: string;

  beforeEach(async () => {
    ctx = await createTestApp();

    mockScriptPath = path.join(ctx.tmpDir, 'mock-build.js');
    writeFileSync(
      mockScriptPath,
      `process.stdout.write('build output line\\n');
process.stderr.write('build warning\\n');
process.exit(0);
`
    );

    initUbtStatements();

    // Create a bare repo so git fetch can run and fail on the branch name
    const bareRepoDir = path.join(ctx.tmpDir, 'bare.git');
    mkdirSync(bareRepoDir);
    execSync('git init --bare', { cwd: bareRepoDir, stdio: 'ignore' });

    // Create staging worktree root and a project path directory, each with a git repo
    // so that git fetch actually runs and produces an error mentioning the branch name.
    stagingRoot = path.join(ctx.tmpDir, 'staging');
    mkdirSync(stagingRoot);

    projectPath = path.join(ctx.tmpDir, 'project');
    mkdirSync(projectPath);
    execSync('git init', { cwd: projectPath, stdio: 'ignore' });

    const config = createTestConfig({
      project: {
        name: 'TestProject',
        path: projectPath,
        uprojectFile: path.join(projectPath, 'Test.uproject'),
      },
      build: {
        scriptPath: `node ${mockScriptPath}`,
        testScriptPath: `node ${mockScriptPath}`,
        defaultTestFilters: ['TestFilter1'],
        buildTimeoutMs: 660_000,
        testTimeoutMs: 700_000,
        ubtRetryCount: 5,
        ubtRetryDelayMs: 30_000,
      },
      server: {
        port: 9100,
        ubtLockTimeoutMs: 600000,
        bareRepoPath: bareRepoDir,
        stagingWorktreeRoot: stagingRoot,
      },
    });

    // Register both agents and build plugins so we can register agents and test branch resolution
    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(buildPlugin, { config });
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.cleanup();
  });

  it('defaults to docker/current-root when no agent is registered', async () => {
    // Create staging dir for this agent name and init git so git fetch actually runs
    const agentDir = path.join(stagingRoot, 'unknown-agent');
    mkdirSync(agentDir);
    execSync('git init', { cwd: agentDir, stdio: 'ignore' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/build',
      headers: { 'x-agent-name': 'unknown-agent' },
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, false, 'build should fail since the branch does not exist');
    assert.ok(
      body.stderr.includes('docker/current-root'),
      `expected stderr to reference default branch "docker/current-root", got: ${body.stderr}`,
    );
  });

  it('defaults to docker/current-root when no X-Agent-Name header is provided', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/build',
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, false, 'build should fail since there is no real git repo');
    assert.ok(
      body.stderr.includes('docker/current-root'),
      `expected stderr to reference default branch "docker/current-root", got: ${body.stderr}`,
    );
  });

  it('uses agent-specific branch when agent is registered with a worktree', async () => {
    // Create staging dir for this agent and init git
    const agentDir = path.join(stagingRoot, 'test-agent');
    mkdirSync(agentDir);
    execSync('git init', { cwd: agentDir, stdio: 'ignore' });

    // Register an agent with a specific worktree/branch
    const regRes = await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'test-agent', worktree: 'docker/test-agent' },
    });
    assert.equal(regRes.statusCode, 200);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/build',
      headers: { 'x-agent-name': 'test-agent' },
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, false, 'build should fail since the branch does not exist');
    assert.ok(
      body.stderr.includes('docker/test-agent'),
      `expected stderr to reference agent branch "docker/test-agent", got: ${body.stderr}`,
    );
  });

  it('uses agent-specific branch for /test endpoint too', async () => {
    // Create staging dir for this agent and init git
    const agentDir = path.join(stagingRoot, 'test-agent');
    mkdirSync(agentDir);
    execSync('git init', { cwd: agentDir, stdio: 'ignore' });

    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'test-agent', worktree: 'docker/test-agent' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-agent-name': 'test-agent' },
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, false, 'test should fail since the branch does not exist');
    assert.ok(
      body.stderr.includes('docker/test-agent'),
      `expected stderr to reference agent branch "docker/test-agent", got: ${body.stderr}`,
    );
  });
});
