import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestConfig } from '../test-helper.js';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import buildPlugin, { isUbtContentionResult } from './build.js';
import { agents } from '../schema/tables.js';

describe('build routes', () => {
  let ctx: DrizzleTestContext;
  let mockScriptPath: string;
  let tmpDir: string;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();

    tmpDir = mkdtempSync(path.join(tmpdir(), 'scaffold-build-test-'));
    mockScriptPath = path.join(tmpDir, 'mock-build.js');
    writeFileSync(
      mockScriptPath,
      `process.stdout.write('build output line\\n');
process.stderr.write('build warning\\n');
process.exit(0);
`
    );

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
        bareRepoPath: tmpDir,
      },
    });

    await ctx.app.register(buildPlugin, { config });
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
    try { rmdirSync(tmpDir, { recursive: true } as any); } catch {}
  });

  it('POST /build returns the correct response shape', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/build',
      payload: {},
    });
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
  let ctx: DrizzleTestContext;
  let mockScriptPath: string;
  let stagingRoot: string;
  let projectPath: string;
  let tmpDir: string;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();

    tmpDir = mkdtempSync(path.join(tmpdir(), 'scaffold-build-test-'));
    mockScriptPath = path.join(tmpDir, 'mock-build.js');
    writeFileSync(
      mockScriptPath,
      `process.stdout.write('build output line\\n');
process.stderr.write('build warning\\n');
process.exit(0);
`
    );

    const bareRepoDir = path.join(tmpDir, 'bare.git');
    mkdirSync(bareRepoDir);
    execSync('git init --bare', { cwd: bareRepoDir, stdio: 'ignore' });

    stagingRoot = path.join(tmpDir, 'staging');
    mkdirSync(stagingRoot);

    projectPath = path.join(tmpDir, 'project');
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

    await ctx.app.register(buildPlugin, { config });
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
    try { rmdirSync(tmpDir, { recursive: true } as any); } catch {}
  });

  it('defaults to docker/default/current-root when no agent is registered', async () => {
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
      body.stderr.includes('docker/default/current-root'),
      `expected stderr to reference default branch "docker/default/current-root", got: ${body.stderr}`,
    );
  });

  it('defaults to docker/default/current-root when no X-Agent-Name header is provided', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/build',
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, false, 'build should fail since there is no real git repo');
    assert.ok(
      body.stderr.includes('docker/default/current-root'),
      `expected stderr to reference default branch "docker/default/current-root", got: ${body.stderr}`,
    );
  });

  it('uses agent-specific branch when agent is registered with a worktree', async () => {
    const agentDir = path.join(stagingRoot, 'test-agent');
    mkdirSync(agentDir);
    execSync('git init', { cwd: agentDir, stdio: 'ignore' });

    // Register agent directly via Drizzle
    await ctx.db.insert(agents).values({
      name: 'test-agent',
      worktree: 'docker/test-agent',
      projectId: 'default',
    });

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
    const agentDir = path.join(stagingRoot, 'test-agent');
    mkdirSync(agentDir);
    execSync('git init', { cwd: agentDir, stdio: 'ignore' });

    await ctx.db.insert(agents).values({
      name: 'test-agent',
      worktree: 'docker/test-agent',
      projectId: 'default',
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

describe('UBT contention detection and retry', () => {
  describe('isUbtContentionResult', () => {
    it('returns false for a clean success', () => {
      assert.equal(
        isUbtContentionResult({ success: true, exit_code: 0, output: 'Build succeeded', stderr: '' }),
        false,
      );
    });

    it('returns false for a genuine compiler failure', () => {
      assert.equal(
        isUbtContentionResult({ success: false, exit_code: 1, output: '', stderr: 'error C2065: undeclared identifier' }),
        false,
      );
    });

    it('returns true when output contains the contention marker', () => {
      assert.equal(
        isUbtContentionResult({
          success: false,
          exit_code: 1,
          output: 'Mutex already set, indicating that a conflicting instance of UBT is running',
          stderr: '',
        }),
        true,
      );
    });

    it('returns true when stderr contains the contention marker', () => {
      assert.equal(
        isUbtContentionResult({
          success: false,
          exit_code: 1,
          output: '',
          stderr: 'Mutex already set, indicating that a conflicting instance of UBT is running',
        }),
        true,
      );
    });

    it('returns true when both output and stderr contain the marker', () => {
      assert.equal(
        isUbtContentionResult({
          success: false,
          exit_code: 1,
          output: 'Global\\UnrealBuildTool_Mutex already set, indicating that a conflicting instance is running',
          stderr: 'ERROR: Mutex already set, indicating that a conflicting instance of UBT is running',
        }),
        true,
      );
    });

    it('returns true when the marker is embedded in a longer message', () => {
      assert.equal(
        isUbtContentionResult({
          success: false,
          exit_code: 1,
          output: '',
          stderr: 'ERROR: Global\\UnrealBuildTool_Mutex_LargeProject was already set, indicating that a conflicting instance of UnrealBuildTool is already running. Aborting.',
        }),
        true,
      );
    });

    it('returns true for real UBT ConflictingInstance output', () => {
      assert.equal(
        isUbtContentionResult({
          success: false,
          exit_code: 1,
          output: 'A conflicting instance of Global\\UnrealBuildTool_Mutex_bbd244c9f44ece8134630190d834139edc42379d is already running.\n\nResult: Failed (ConflictingInstance)\nTotal execution time: 0.48 seconds',
          stderr: '',
        }),
        true,
      );
    });

    it('returns true when Result line contains ConflictingInstance', () => {
      assert.equal(
        isUbtContentionResult({
          success: false,
          exit_code: 1,
          output: 'Result: Failed (ConflictingInstance)',
          stderr: '',
        }),
        true,
      );
    });

    it('returns false for empty output and stderr', () => {
      assert.equal(
        isUbtContentionResult({ success: false, exit_code: 1, output: '', stderr: '' }),
        false,
      );
    });
  });
});
