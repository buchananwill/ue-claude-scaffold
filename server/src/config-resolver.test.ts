import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProjectConfig } from './config-resolver.js';
import { createTestConfig } from './test-helper.js';

describe('resolveProjectConfig', () => {
  it('resolves a legacy (default) project config', () => {
    const config = createTestConfig();
    const resolved = resolveProjectConfig('default', config);

    assert.equal(resolved.projectId, 'default');
    assert.equal(resolved.name, 'TestProject');
    assert.equal(resolved.path, '/tmp/test-project');
    assert.equal(resolved.bareRepoPath, '/tmp/test-repo.git');
    assert.equal(resolved.seedBranch, 'docker/default/current-root');
    assert.equal(resolved.serverPort, 9100);
    assert.equal(resolved.enginePath, '/tmp/engine');
    assert.equal(resolved.engineVersion, '5.4');
    assert.equal(resolved.buildScriptPath, '/tmp/build.sh');
    assert.equal(resolved.testScriptPath, '/tmp/test.sh');
    assert.equal(resolved.buildTimeoutMs, 660_000);
    assert.equal(resolved.testTimeoutMs, 700_000);
    assert.deepEqual(resolved.defaultTestFilters, []);
    assert.equal(resolved.stagingWorktreeRoot, null);
    assert.equal(resolved.logsPath, null);
    assert.equal(resolved.agentType, null);
    assert.deepEqual(resolved.hooks, { buildIntercept: null, cppLint: null });
  });

  it('resolves a multi-project config', () => {
    const config = createTestConfig({
      resolvedProjects: {
        'my-game': {
          name: 'MyGame',
          path: '/projects/mygame',
          bareRepoPath: '/repos/mygame.git',
          seedBranch: 'custom-seed',
          engine: { path: '/engines/5.5', version: '5.5' },
          build: {
            scriptPath: '/scripts/build.py',
            testScriptPath: '/scripts/test.py',
            buildTimeoutMs: 120_000,
            testTimeoutMs: 180_000,
          },
          stagingWorktreeRoot: '/staging/mygame',
        },
        'other-project': {
          name: 'Other',
          path: '/projects/other',
          bareRepoPath: '/repos/other.git',
        },
      },
    });

    const resolved = resolveProjectConfig('my-game', config);
    assert.equal(resolved.projectId, 'my-game');
    assert.equal(resolved.name, 'MyGame');
    assert.equal(resolved.path, '/projects/mygame');
    assert.equal(resolved.bareRepoPath, '/repos/mygame.git');
    assert.equal(resolved.seedBranch, 'custom-seed');
    assert.equal(resolved.enginePath, '/engines/5.5');
    assert.equal(resolved.engineVersion, '5.5');
    assert.equal(resolved.buildScriptPath, '/scripts/build.py');
    assert.equal(resolved.testScriptPath, '/scripts/test.py');
    assert.equal(resolved.buildTimeoutMs, 120_000);
    assert.equal(resolved.testTimeoutMs, 180_000);
    assert.equal(resolved.stagingWorktreeRoot, '/staging/mygame');

    // Second project resolves too
    const other = resolveProjectConfig('other-project', config);
    assert.equal(other.projectId, 'other-project');
    assert.equal(other.name, 'Other');
    assert.equal(other.enginePath, null);
    assert.equal(other.buildScriptPath, null);
    // Falls back to config.build defaults for timeouts
    assert.equal(other.buildTimeoutMs, 660_000);
    assert.equal(other.testTimeoutMs, 700_000);
  });

  it('throws for an unknown project id', () => {
    const config = createTestConfig();
    assert.throws(
      () => resolveProjectConfig('nonexistent', config),
      /Unknown project.*nonexistent/,
    );
  });

  it('resolves correctly when engine is not configured', () => {
    const config = createTestConfig({
      resolvedProjects: {
        'no-engine': {
          name: 'NoEngine',
          path: '/projects/noengine',
          bareRepoPath: '/repos/noengine.git',
          // No engine block
        },
      },
    });

    const resolved = resolveProjectConfig('no-engine', config);
    assert.equal(resolved.enginePath, null);
    assert.equal(resolved.engineVersion, null);
    assert.equal(resolved.seedBranch, 'docker/no-engine/current-root');
    // Should still have valid defaults for other fields
    assert.equal(resolved.projectId, 'no-engine');
    assert.equal(resolved.name, 'NoEngine');
    assert.equal(resolved.path, '/projects/noengine');
  });

  it('uses custom server port from config', () => {
    const config = createTestConfig({
      server: {
        port: 8080,
        ubtLockTimeoutMs: 600000,
        bareRepoPath: '/tmp/test-repo.git',
      },
    });

    const resolved = resolveProjectConfig('default', config);
    assert.equal(resolved.serverPort, 8080);
  });

  it('uses custom defaultTestFilters from config', () => {
    const config = createTestConfig({
      build: {
        scriptPath: '/tmp/build.sh',
        testScriptPath: '/tmp/test.sh',
        defaultTestFilters: ['MyModule', 'OtherModule'],
        buildTimeoutMs: 660_000,
        testTimeoutMs: 700_000,
        ubtRetryCount: 5,
        ubtRetryDelayMs: 30_000,
      },
    });

    const resolved = resolveProjectConfig('default', config);
    assert.deepEqual(resolved.defaultTestFilters, ['MyModule', 'OtherModule']);
  });
});

