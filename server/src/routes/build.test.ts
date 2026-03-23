import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, createTestConfig, type TestContext } from '../test-helper.js';
import { writeFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import buildPlugin, { isUbtContentionResult } from './build.js';
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

  describe('integration', () => {
    let ctx: TestContext;
    let projectPath: string;
    let bareRepoDir: string;

    beforeEach(async () => {
      ctx = await createTestApp();
      initUbtStatements();

      // Set up a bare repo with a docker/current-root branch so syncWorktree succeeds
      bareRepoDir = path.join(ctx.tmpDir, 'bare.git');
      mkdirSync(bareRepoDir);
      execSync('git init --bare', { cwd: bareRepoDir, stdio: 'ignore' });

      // Create a temporary repo, make a commit, push to the bare repo's docker/current-root
      const seedDir = path.join(ctx.tmpDir, 'seed');
      mkdirSync(seedDir);
      execSync('git init', { cwd: seedDir, stdio: 'ignore' });
      execSync('git checkout -b docker/current-root', { cwd: seedDir, stdio: 'ignore' });
      writeFileSync(path.join(seedDir, 'dummy.txt'), 'seed');
      execSync('git add .', { cwd: seedDir, stdio: 'ignore' });
      execSync('git -c user.email="t@t" -c user.name="t" commit -m "seed"', { cwd: seedDir, stdio: 'ignore' });
      execSync(`git push "${bareRepoDir}" docker/current-root`, { cwd: seedDir, stdio: 'ignore' });

      // Create a project path that is a clone so git fetch + reset work
      projectPath = path.join(ctx.tmpDir, 'project');
      execSync(`git clone "${bareRepoDir}" "${projectPath}"`, { stdio: 'ignore' });
      execSync('git checkout -b docker/current-root origin/docker/current-root', { cwd: projectPath, stdio: 'ignore' });

      // Push a second commit so the staging worktree (projectPath) is behind
      // the bare repo — syncWorktree will return 'changed' and actually run the build.
      writeFileSync(path.join(seedDir, 'dummy.txt'), 'updated');
      execSync('git add .', { cwd: seedDir, stdio: 'ignore' });
      execSync('git -c user.email="t@t" -c user.name="t" commit -m "trigger change"', { cwd: seedDir, stdio: 'ignore' });
      execSync(`git push "${bareRepoDir}" docker/current-root`, { cwd: seedDir, stdio: 'ignore' });
    });

    afterEach(async () => {
      await ctx.app.close();
      ctx.cleanup();
    });

    it('POST /build retries and succeeds after transient contention', async () => {
      const counterFile = path.join(ctx.tmpDir, 'build-counter.txt');
      writeFileSync(counterFile, '0');

      const mockScript = path.join(ctx.tmpDir, 'contention-build.sh');
      writeFileSync(
        mockScript,
        `#!/bin/bash
COUNTER_FILE="${counterFile.replace(/\\/g, '/')}"
COUNT=$(cat "$COUNTER_FILE")
COUNT=$((COUNT + 1))
echo -n "$COUNT" > "$COUNTER_FILE"
if [ "$COUNT" -eq 1 ]; then
  echo -n "Mutex already set, indicating that a conflicting instance of UBT is running" >&2
  exit 1
else
  echo -n "Build succeeded"
  exit 0
fi
`
      );

      const config = createTestConfig({
        project: {
          name: 'TestProject',
          path: projectPath,
          uprojectFile: path.join(projectPath, 'Test.uproject'),
        },
        build: {
          scriptPath: mockScript,
          testScriptPath: mockScript,
          defaultTestFilters: [],
          buildTimeoutMs: 660_000,
          testTimeoutMs: 700_000,
          ubtRetryCount: 3,
          ubtRetryDelayMs: 50,
        },
        server: {
          port: 9100,
          ubtLockTimeoutMs: 600000,
          bareRepoPath: bareRepoDir,
        },
      });

      await ctx.app.register(buildPlugin, { config });

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/build',
        payload: {},
      });
      const body = res.json();
      assert.equal(body.success, true);
    });

    it('POST /build returns contention error after exhausting retries', async () => {
      const mockScript = path.join(ctx.tmpDir, 'always-contention.sh');
      writeFileSync(
        mockScript,
        `#!/bin/bash
echo -n "Mutex already set, indicating that a conflicting instance of UBT is running" >&2
exit 1
`
      );

      const config = createTestConfig({
        project: {
          name: 'TestProject',
          path: projectPath,
          uprojectFile: path.join(projectPath, 'Test.uproject'),
        },
        build: {
          scriptPath: mockScript,
          testScriptPath: mockScript,
          defaultTestFilters: [],
          buildTimeoutMs: 660_000,
          testTimeoutMs: 700_000,
          ubtRetryCount: 2,
          ubtRetryDelayMs: 50,
        },
        server: {
          port: 9100,
          ubtLockTimeoutMs: 600000,
          bareRepoPath: bareRepoDir,
        },
      });

      await ctx.app.register(buildPlugin, { config });

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/build',
        payload: {},
      });
      const body = res.json();
      assert.equal(body.success, false);
      assert.equal(body.exit_code, -1);
      assert.ok(body.stderr.includes('UBT external lock contention'));
    });

    it('POST /test retries and succeeds after transient contention', async () => {
      const counterFile = path.join(ctx.tmpDir, 'test-counter.txt');
      writeFileSync(counterFile, '0');

      const mockScript = path.join(ctx.tmpDir, 'contention-test.sh');
      writeFileSync(
        mockScript,
        `#!/bin/bash
COUNTER_FILE="${counterFile.replace(/\\/g, '/')}"
COUNT=$(cat "$COUNTER_FILE")
COUNT=$((COUNT + 1))
echo -n "$COUNT" > "$COUNTER_FILE"
if [ "$COUNT" -eq 1 ]; then
  echo -n "Mutex already set, indicating that a conflicting instance of UBT is running" >&2
  exit 1
else
  echo -n "Tests passed"
  exit 0
fi
`
      );

      const config = createTestConfig({
        project: {
          name: 'TestProject',
          path: projectPath,
          uprojectFile: path.join(projectPath, 'Test.uproject'),
        },
        build: {
          scriptPath: mockScript,
          testScriptPath: mockScript,
          defaultTestFilters: [],
          buildTimeoutMs: 660_000,
          testTimeoutMs: 700_000,
          ubtRetryCount: 3,
          ubtRetryDelayMs: 50,
        },
        server: {
          port: 9100,
          ubtLockTimeoutMs: 600000,
          bareRepoPath: bareRepoDir,
        },
      });

      await ctx.app.register(buildPlugin, { config });

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/test',
        payload: {},
      });
      const body = res.json();
      assert.equal(body.success, true);
    });

    it('POST /build succeeds immediately without retrying when no contention', async () => {
      const mockScript = path.join(ctx.tmpDir, 'instant-success.sh');
      writeFileSync(
        mockScript,
        `#!/bin/bash
echo -n "Build succeeded"
exit 0
`
      );

      const config = createTestConfig({
        project: {
          name: 'TestProject',
          path: projectPath,
          uprojectFile: path.join(projectPath, 'Test.uproject'),
        },
        build: {
          scriptPath: mockScript,
          testScriptPath: mockScript,
          defaultTestFilters: [],
          buildTimeoutMs: 660_000,
          testTimeoutMs: 700_000,
          ubtRetryCount: 3,
          ubtRetryDelayMs: 60_000, // long delay proves we did not retry
        },
        server: {
          port: 9100,
          ubtLockTimeoutMs: 600000,
          bareRepoPath: bareRepoDir,
        },
      });

      await ctx.app.register(buildPlugin, { config });

      const t0 = Date.now();
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/build',
        payload: {},
      });
      const elapsed = Date.now() - t0;
      const body = res.json();
      assert.equal(body.success, true);
      assert.equal(body.output, 'Build succeeded');
      // If it retried even once, it would have waited 60s. A generous bound of 10s proves no retry occurred.
      assert.ok(elapsed < 10_000, `Expected fast completion (no retry), but took ${elapsed}ms`);
    });
  });
});
