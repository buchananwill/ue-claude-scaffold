import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from './config.js';

/**
 * loadConfig() searches for scaffold.config.json in cwd and parent.
 * We write a temp config file and run loadConfig() from that directory.
 */
function loadConfigFromJson(json: Record<string, unknown>): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(path.join(tmpdir(), 'config-test-'));
  const configPath = path.join(dir, 'scaffold.config.json');
  writeFileSync(configPath, JSON.stringify(json));

  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    return loadConfig();
  } finally {
    process.chdir(originalCwd);
    try { unlinkSync(configPath); } catch {}
    try { rmdirSync(dir); } catch {}
  }
}

/** A minimal valid config object for tests to spread/override. */
const validRaw = {
  project: { name: 'Test', path: '/tmp/proj', uprojectFile: '/tmp/proj/T.uproject' },
  engine: { path: '/tmp/engine', version: '5.4' },
  build: { scriptPath: '/tmp/b.sh', testScriptPath: '/tmp/t.sh' },
  server: { port: 9100, bareRepoPath: '/tmp/repo.git' },
};

describe('loadConfig() validation', () => {
  it('loads a valid config successfully', () => {
    const config = loadConfigFromJson(validRaw);
    assert.equal(config.server.bareRepoPath, '/tmp/repo.git');
    assert.equal(config.project.name, 'Test');
  });

  it('requires bareRepoPath — missing bareRepoPath throws', () => {
    const raw = {
      ...validRaw,
      server: { port: 9100 },
    };
    assert.throws(
      () => loadConfigFromJson(raw),
      (err: Error) => {
        assert.match(err.message, /bareRepoPath/);
        return true;
      },
    );
  });

  it('does not fall back from bareRepoRoot — bareRepoRoot without bareRepoPath still throws', () => {
    const raw = {
      ...validRaw,
      server: { port: 9100, bareRepoRoot: '/tmp/roots' },
    };
    assert.throws(
      () => loadConfigFromJson(raw),
      (err: Error) => {
        assert.match(err.message, /bareRepoPath/);
        return true;
      },
    );
  });

  it('staging worktree validation passes when project.path is set (no stagingWorktreeRoot needed)', () => {
    // validRaw has project.path set and no stagingWorktreeRoot — should succeed
    const config = loadConfigFromJson(validRaw);
    assert.equal(config.server.stagingWorktreeRoot, undefined);
    assert.equal(config.project.path, '/tmp/proj');
  });

  it('staging worktree validation passes when stagingWorktreeRoot is set', () => {
    const raw = {
      ...validRaw,
      server: { ...validRaw.server, stagingWorktreeRoot: '/tmp/staging' },
    };
    const config = loadConfigFromJson(raw);
    assert.equal(config.server.stagingWorktreeRoot, '/tmp/staging');
  });

  it('staging worktree validation fails when neither stagingWorktreeRoot nor project.path is set', () => {
    const raw = {
      ...validRaw,
      project: { name: 'Test', path: '', uprojectFile: '' },
    };
    assert.throws(
      () => loadConfigFromJson(raw),
      (err: Error) => {
        assert.match(err.message, /stagingWorktreeRoot/);
        return true;
      },
    );
  });

  it('stagingWorktreePath in raw input is not surfaced on the returned config', () => {
    const raw = {
      ...validRaw,
      server: { ...validRaw.server, stagingWorktreePath: '/tmp/old-style' },
    };
    const config = loadConfigFromJson(raw);
    // The returned type should not have stagingWorktreePath
    assert.equal((config.server as Record<string, unknown>)['stagingWorktreePath'], undefined);
  });
});
