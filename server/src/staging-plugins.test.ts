import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ensureStagingPlugins, refreshStagingPlugins } from './staging-plugins.js';
import { createTestConfig } from './test-helper.js';

describe('staging-plugins', () => {
  let tmpDir: string;
  let worktreePath: string;
  let pluginSource: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'staging-plugins-test-'));
    worktreePath = path.join(tmpDir, 'worktree');
    pluginSource = path.join(tmpDir, 'plugin-source');

    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(path.join(worktreePath, 'Plugins'), { recursive: true });

    // Create a fake plugin source with some files
    mkdirSync(path.join(pluginSource, 'Source'), { recursive: true });
    mkdirSync(path.join(pluginSource, 'Intermediate', 'Build'), { recursive: true });
    mkdirSync(path.join(pluginSource, 'Binaries'), { recursive: true });
    writeFileSync(path.join(pluginSource, 'MyPlugin.uplugin'), '{}');
    writeFileSync(path.join(pluginSource, 'Source', 'MyPlugin.cpp'), '// code');
    writeFileSync(path.join(pluginSource, 'Intermediate', 'Build', 'cache.bin'), 'cached');
    writeFileSync(path.join(pluginSource, 'Binaries', 'MyPlugin.dll'), 'binary');
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('skips when no stagingCopies configured', async () => {
    const config = createTestConfig();
    const results = await ensureStagingPlugins(worktreePath, config);
    assert.equal(results.length, 0);
  });

  it('skips when source does not exist', async () => {
    const config = createTestConfig({
      plugins: {
        stagingCopies: [{ source: path.join(tmpDir, 'nonexistent'), relativeDest: 'Plugins/Foo' }],
      },
    });
    const results = await ensureStagingPlugins(worktreePath, config);
    assert.equal(results.length, 1);
    assert.equal(results[0].action, 'skipped');
  });

  it('copies plugin source into worktree (excluding Intermediate/Binaries)', async () => {
    const config = createTestConfig({
      plugins: {
        stagingCopies: [{ source: pluginSource, relativeDest: 'Plugins/MyPlugin' }],
      },
    });

    const results = await ensureStagingPlugins(worktreePath, config);
    assert.equal(results.length, 1);
    assert.equal(results[0].action, 'copied');

    const dest = path.join(worktreePath, 'Plugins', 'MyPlugin');
    assert.ok(existsSync(dest), 'destination should exist');
    assert.ok(existsSync(path.join(dest, 'MyPlugin.uplugin')), '.uplugin should be copied');
    assert.ok(existsSync(path.join(dest, 'Source', 'MyPlugin.cpp')), 'Source/ should be copied');

    // Intermediate and Binaries should NOT be copied from source
    assert.ok(!existsSync(path.join(dest, 'Intermediate', 'Build', 'cache.bin')), 'Intermediate should be excluded');
    assert.ok(!existsSync(path.join(dest, 'Binaries', 'MyPlugin.dll')), 'Binaries should be excluded');
  });

  it('skips copy when destination already exists as real directory', async () => {
    const dest = path.join(worktreePath, 'Plugins', 'MyPlugin');
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, 'marker.txt'), 'existing');

    const config = createTestConfig({
      plugins: {
        stagingCopies: [{ source: pluginSource, relativeDest: 'Plugins/MyPlugin' }],
      },
    });

    const results = await ensureStagingPlugins(worktreePath, config);
    assert.equal(results.length, 1);
    assert.equal(results[0].action, 'skipped');

    // Original marker file should still be there
    assert.ok(existsSync(path.join(dest, 'marker.txt')));
  });

  it('replaces symlink with real copy', async () => {
    const dest = path.join(worktreePath, 'Plugins', 'MyPlugin');
    // Create a symlink (junction-like) pointing to source
    symlinkSync(pluginSource, dest, 'junction');
    assert.ok(lstatSync(dest).isSymbolicLink(), 'precondition: should be a symlink');

    const config = createTestConfig({
      plugins: {
        stagingCopies: [{ source: pluginSource, relativeDest: 'Plugins/MyPlugin' }],
      },
    });

    const results = await ensureStagingPlugins(worktreePath, config);
    assert.equal(results.length, 1);
    assert.equal(results[0].action, 'copied');

    // Should now be a real directory, not a symlink
    assert.ok(existsSync(dest), 'destination should exist');
    assert.ok(!lstatSync(dest).isSymbolicLink(), 'should no longer be a symlink');
    assert.ok(existsSync(path.join(dest, 'MyPlugin.uplugin')), 'files should be copied');
  });

  it('refreshStagingPlugins re-copies even when dest exists', async () => {
    const dest = path.join(worktreePath, 'Plugins', 'MyPlugin');
    mkdirSync(dest, { recursive: true });
    // Simulate existing Intermediate dir that should be preserved
    mkdirSync(path.join(dest, 'Intermediate'), { recursive: true });
    writeFileSync(path.join(dest, 'Intermediate', 'agent-cache.bin'), 'agent data');

    const config = createTestConfig({
      plugins: {
        stagingCopies: [{ source: pluginSource, relativeDest: 'Plugins/MyPlugin' }],
      },
    });

    const results = await refreshStagingPlugins(worktreePath, config);
    assert.equal(results.length, 1);
    assert.equal(results[0].action, 'copied');

    // Source files should be there
    assert.ok(existsSync(path.join(dest, 'MyPlugin.uplugin')));
    // Agent's own Intermediate should be preserved (robocopy /XD Intermediate)
    assert.ok(existsSync(path.join(dest, 'Intermediate', 'agent-cache.bin')),
      'agent Intermediate files should be preserved');
  });
});
