import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestConfig } from '../test-helper.js';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import buildPlugin, { isUbtContentionResult } from './build.js';
import agentsPlugin from './agents.js';

/** Shared setup for build test blocks: creates tmpDir, mock script, and base config. */
function createMockBuildFixture() {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'scaffold-build-test-'));
  const mockScriptPath = path.join(tmpDir, 'mock-build.js');
  writeFileSync(
    mockScriptPath,
    `process.stdout.write('build output line\\n');
process.stderr.write('build warning\\n');
process.exit(0);
`
  );
  const baseBuildConfig = {
    scriptPath: `node ${mockScriptPath}`,
    testScriptPath: `node ${mockScriptPath}`,
    defaultTestFilters: ['TestFilter1'],
    buildTimeoutMs: 660_000,
    testTimeoutMs: 700_000,
    ubtRetryCount: 5,
    ubtRetryDelayMs: 30_000,
  };
  return { tmpDir, mockScriptPath, baseBuildConfig };
}

/**
 * Creates a full build test context with Drizzle app, tmpDir, config, and registered plugins.
 * Returns a cleanup function that closes the app, cleans up the DB, and removes tmpDir.
 */
async function createBuildTestContext(tmpDir: string, configOverrides: Parameters<typeof createTestConfig>[0], opts?: {
  registerAgents?: boolean;
}) {
  const ctx = await createDrizzleTestApp();
  const config = createTestConfig(configOverrides);
  if (opts?.registerAgents) {
    await ctx.app.register(agentsPlugin, { config });
  }
  await ctx.app.register(buildPlugin, { config });
  await ctx.app.ready();

  const cleanup = async () => {
    await ctx.app.close();
    await ctx.cleanup();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp dir cleanup -- safe to ignore */ }
  };

  return { ctx, config, cleanup };
}

/**
 * Creates bare repo, staging worktree root, and optionally a seed clone with initial content.
 * Returns paths and a helper to push branches from the seed clone.
 */
function createGitTestInfrastructure(tmpDir: string, opts?: {
  seedSetup?: (seedDir: string, bareRepoDir: string) => void;
  cloneAgent?: { name: string };
  projectId?: string;
}) {
  const bareRepoDir = path.join(tmpDir, 'bare.git');
  mkdirSync(bareRepoDir);
  execSync('git init --bare', { cwd: bareRepoDir, stdio: 'ignore' });

  const stagingRoot = path.join(tmpDir, 'staging');
  mkdirSync(stagingRoot, { recursive: true });

  const projectPath = path.join(tmpDir, 'project');
  mkdirSync(projectPath);
  execSync('git init', { cwd: projectPath, stdio: 'ignore' });

  if (opts?.seedSetup) {
    const seedDir = path.join(tmpDir, 'seed');
    // The seedSetup callback is responsible for cloning and populating the seed dir
    opts.seedSetup(seedDir, bareRepoDir);
  }

  const projectId = opts?.projectId ?? 'default';
  let agentStagingDir: string | undefined;
  if (opts?.cloneAgent) {
    const agentName = opts.cloneAgent.name;
    agentStagingDir = path.join(stagingRoot, agentName);
    execFileSync('git', ['clone', bareRepoDir, agentName, '--branch', `docker/${projectId}/${agentName}`], {
      cwd: stagingRoot,
      stdio: 'ignore',
    });
    execSync('git config user.email "test@test.com"', { cwd: agentStagingDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: agentStagingDir, stdio: 'ignore' });
  }

  return { bareRepoDir, stagingRoot, projectPath, agentStagingDir };
}

describe('build routes', () => {
  let ctx: DrizzleTestContext;
  let tmpDir: string;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    const setup = createMockBuildFixture();
    tmpDir = setup.tmpDir;

    const harness = await createBuildTestContext(tmpDir, {
      build: setup.baseBuildConfig,
      server: {
        port: 9100,
        ubtLockTimeoutMs: 600000,
        bareRepoPath: tmpDir,
      },
    });
    ctx = harness.ctx;
    teardown = harness.cleanup;
  });

  afterEach(async () => {
    await teardown();
  });

  it('POST /build returns the correct response shape', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/build',
      headers: { 'x-project-id': 'default' },
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
      headers: { 'x-project-id': 'default' },
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
  let stagingRoot: string;
  let tmpDir: string;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    const setup = createMockBuildFixture();
    tmpDir = setup.tmpDir;

    const git = createGitTestInfrastructure(tmpDir);
    stagingRoot = git.stagingRoot;

    const harness = await createBuildTestContext(tmpDir, {
      project: {
        name: 'TestProject',
        path: git.projectPath,
        uprojectFile: path.join(git.projectPath, 'Test.uproject'),
      },
      build: setup.baseBuildConfig,
      server: {
        port: 9100,
        ubtLockTimeoutMs: 600000,
        bareRepoPath: git.bareRepoDir,
        stagingWorktreeRoot: git.stagingRoot,
      },
    }, { registerAgents: true });
    ctx = harness.ctx;
    teardown = harness.cleanup;
  });

  afterEach(async () => {
    await teardown();
  });

  it('defaults to docker/default/current-root when no agent is registered', async () => {
    const agentDir = path.join(stagingRoot, 'unknown-agent');
    mkdirSync(agentDir);
    execSync('git init', { cwd: agentDir, stdio: 'ignore' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/build',
      headers: { 'x-agent-name': 'unknown-agent', 'x-project-id': 'default' },
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
      headers: { 'x-project-id': 'default' },
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

    // Register agent via route
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'test-agent', worktree: 'docker/default/test-agent' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/build',
      headers: { 'x-agent-name': 'test-agent', 'x-project-id': 'default' },
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, false, 'build should fail since the branch does not exist');
    assert.ok(
      body.stderr.includes('docker/default/test-agent'),
      `expected stderr to reference agent branch "docker/default/test-agent", got: ${body.stderr}`,
    );
  });

  it('uses agent-specific branch for /test endpoint too', async () => {
    const agentDir = path.join(stagingRoot, 'test-agent');
    mkdirSync(agentDir);
    execSync('git init', { cwd: agentDir, stdio: 'ignore' });

    // Register agent via route
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'test-agent', worktree: 'docker/default/test-agent' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-agent-name': 'test-agent', 'x-project-id': 'default' },
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, false, 'test should fail since the branch does not exist');
    assert.ok(
      body.stderr.includes('docker/default/test-agent'),
      `expected stderr to reference agent branch "docker/default/test-agent", got: ${body.stderr}`,
    );
  });
});

describe('build route x-agent-name validation', () => {
  let ctx: DrizzleTestContext;
  let tmpDir: string;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    const setup = createMockBuildFixture();
    tmpDir = setup.tmpDir;

    const harness = await createBuildTestContext(tmpDir, {
      build: setup.baseBuildConfig,
      server: {
        port: 9100,
        ubtLockTimeoutMs: 600000,
        bareRepoPath: tmpDir,
      },
    });
    ctx = harness.ctx;
    teardown = harness.cleanup;
  });

  afterEach(async () => {
    await teardown();
  });

  it('POST /build rejects malformed x-agent-name with path traversal', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/build',
      headers: { 'x-agent-name': '../../evil', 'x-project-id': 'default' },
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, false);
    assert.ok(body.stderr.includes('Invalid X-Agent-Name header format'));
  });

  it('POST /test rejects malformed x-agent-name with path traversal', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-agent-name': '../../evil', 'x-project-id': 'default' },
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, false);
    assert.ok(body.stderr.includes('Invalid X-Agent-Name header format'));
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

describe('build route staging worktree sync', () => {
  let ctx: DrizzleTestContext;
  let tmpDir: string;
  let agentStagingDir: string;
  let teardown: () => Promise<void>;

  const OLD_FILE = 'Source/Public/OldComponent.h';
  const NEW_FILE = 'Source/Public/NewComponent.h';

  /** Generate a block of lines that will be shared between old and new files. */
  function sharedContent(): string {
    const lines: string[] = [];
    lines.push('#pragma once');
    lines.push('#include "CoreMinimal.h"');
    lines.push('');
    for (let i = 0; i < 50; i++) {
      lines.push(`// Shared boilerplate line ${i}: this content is identical in both files.`);
    }
    return lines.join('\n');
  }

  function oldFileContent(): string {
    const lines: string[] = [sharedContent()];
    for (let i = 0; i < 10; i++) {
      lines.push(`// Old-only line ${i}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  function newFileContent(): string {
    const lines: string[] = [sharedContent()];
    for (let i = 0; i < 10; i++) {
      lines.push(`// New-only line ${i}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'scaffold-build-sync-'));

    const git = createGitTestInfrastructure(tmpDir, {
      seedSetup: (seedDir, bareRepoDir) => {
        // Create seed working clone, make initial commit with OLD_FILE
        execSync(`git clone "${bareRepoDir}" seed`, { cwd: path.dirname(seedDir), stdio: 'ignore' });
        execSync('git config user.email "test@test.com"', { cwd: seedDir, stdio: 'ignore' });
        execSync('git config user.name "Test"', { cwd: seedDir, stdio: 'ignore' });

        // Create OLD_FILE with enough content for rename detection
        const oldDir = path.join(seedDir, path.dirname(OLD_FILE));
        mkdirSync(oldDir, { recursive: true });
        writeFileSync(path.join(seedDir, OLD_FILE), oldFileContent());

        execSync('git add -A', { cwd: seedDir, stdio: 'ignore' });
        execSync('git commit -m "initial commit with old file"', { cwd: seedDir, stdio: 'ignore' });

        // Push to docker/default/current-root and docker/default/test-agent
        execSync('git checkout -b docker/default/current-root', { cwd: seedDir, stdio: 'ignore' });
        execSync(`git push "${bareRepoDir}" docker/default/current-root`, { cwd: seedDir, stdio: 'ignore' });
        execSync('git checkout -b docker/default/test-agent', { cwd: seedDir, stdio: 'ignore' });
        execSync(`git push "${bareRepoDir}" docker/default/test-agent`, { cwd: seedDir, stdio: 'ignore' });
      },
      cloneAgent: { name: 'test-agent' },
    });

    agentStagingDir = git.agentStagingDir!;

    // Create mock build script
    const mockScriptPath = path.join(tmpDir, 'mock-build.js');
    writeFileSync(
      mockScriptPath,
      `process.stdout.write('build ok\\n');
process.exit(0);
`
    );

    const harness = await createBuildTestContext(tmpDir, {
      project: {
        name: 'TestProject',
        path: agentStagingDir,
        uprojectFile: path.join(agentStagingDir, 'Test.uproject'),
      },
      build: {
        scriptPath: `node ${mockScriptPath}`,
        testScriptPath: `node ${mockScriptPath}`,
        defaultTestFilters: [],
        buildTimeoutMs: 660_000,
        testTimeoutMs: 700_000,
        ubtRetryCount: 5,
        ubtRetryDelayMs: 30_000,
      },
      server: {
        port: 9100,
        ubtLockTimeoutMs: 600000,
        bareRepoPath: git.bareRepoDir,
        stagingWorktreeRoot: git.stagingRoot,
      },
    }, { registerAgents: true });
    ctx = harness.ctx;
    teardown = harness.cleanup;

    // Register the agent
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      headers: { 'x-project-id': 'default' },
      payload: { name: 'test-agent', worktree: 'docker/default/test-agent' },
    });
  });

  afterEach(async () => {
    await teardown();
  });

  it('removes the old file when git detects a rename', async () => {
    const seedDir = path.join(tmpDir, 'seed');
    const bareRepoDir = path.join(tmpDir, 'bare.git');

    // First build to establish refs/scaffold/last-sync
    const res1 = await ctx.app.inject({
      method: 'POST',
      url: '/build',
      headers: { 'x-agent-name': 'test-agent', 'x-project-id': 'default' },
      payload: {},
    });
    assert.equal(res1.statusCode, 200);

    // In the seed clone, delete OLD_FILE and add NEW_FILE with overlapping content
    execSync('git checkout docker/default/test-agent', { cwd: seedDir, stdio: 'ignore' });
    execSync(`git rm "${OLD_FILE}"`, { cwd: seedDir, stdio: 'ignore' });
    const newDir = path.join(seedDir, path.dirname(NEW_FILE));
    mkdirSync(newDir, { recursive: true });
    writeFileSync(path.join(seedDir, NEW_FILE), newFileContent());
    execSync('git add -A', { cwd: seedDir, stdio: 'ignore' });
    execSync('git commit -m "rename: delete old, add new with similar content"', {
      cwd: seedDir,
      stdio: 'ignore',
    });
    execSync(`git push "${bareRepoDir}" docker/default/test-agent`, {
      cwd: seedDir,
      stdio: 'ignore',
    });

    // Second build triggers sync with the rename commit
    const res2 = await ctx.app.inject({
      method: 'POST',
      url: '/build',
      headers: { 'x-agent-name': 'test-agent', 'x-project-id': 'default' },
      payload: {},
    });
    assert.equal(res2.statusCode, 200);

    // Assert: old file must be gone, new file must exist
    const oldPath = path.join(agentStagingDir, OLD_FILE);
    const newPath = path.join(agentStagingDir, NEW_FILE);

    assert.equal(
      existsSync(oldPath),
      false,
      `Old file should have been removed from staging worktree: ${oldPath}`,
    );
    assert.equal(
      existsSync(newPath),
      true,
      `New file should exist in staging worktree: ${newPath}`,
    );
  });
});
