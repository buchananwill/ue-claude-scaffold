import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, getProject } from './config.js';

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

/** A valid multi-project config with two projects. */
const multiProjectRaw = {
  server: { port: 9100 },
  projects: {
    alpha: {
      name: 'Alpha',
      path: '/tmp/alpha',
      bareRepoPath: '/tmp/alpha.git',
      engine: { path: '/tmp/engine', version: '5.4' },
    },
    beta: {
      name: 'Beta',
      path: '/tmp/beta',
      bareRepoPath: '/tmp/beta.git',
    },
  },
};

describe('multi-project config', () => {
  it('resolves two projects with correct fields', () => {
    const config = loadConfigFromJson(multiProjectRaw);
    assert.ok(config.resolvedProjects['alpha']);
    assert.ok(config.resolvedProjects['beta']);
    assert.equal(config.resolvedProjects['alpha'].name, 'Alpha');
    assert.equal(config.resolvedProjects['alpha'].path, '/tmp/alpha');
    assert.equal(config.resolvedProjects['alpha'].bareRepoPath, '/tmp/alpha.git');
    assert.deepEqual(config.resolvedProjects['alpha'].engine, { path: '/tmp/engine', version: '5.4' });
    assert.equal(config.resolvedProjects['beta'].name, 'Beta');
    assert.equal(config.resolvedProjects['beta'].path, '/tmp/beta');
    assert.equal(config.resolvedProjects['beta'].bareRepoPath, '/tmp/beta.git');
  });

  it('legacy config synthesises resolvedProjects["default"] with all expected fields', () => {
    const raw = {
      ...validRaw,
      server: { ...validRaw.server, stagingWorktreeRoot: '/tmp/staging' },
      tasks: { seedBranch: 'plans' },
    };
    const config = loadConfigFromJson(raw);
    const def = config.resolvedProjects['default'];
    assert.ok(def);
    assert.equal(def.name, 'Test');
    assert.equal(def.path, '/tmp/proj');
    assert.equal(def.bareRepoPath, '/tmp/repo.git');
    assert.deepEqual(def.engine, { path: '/tmp/engine', version: '5.4' });
    assert.ok(def.build);
    assert.equal(def.build?.scriptPath, '/tmp/b.sh');
    assert.equal(def.seedBranch, 'plans');
    assert.equal(def.stagingWorktreeRoot, '/tmp/staging');
  });

  it('getProject returns the correct project by id', () => {
    const config = loadConfigFromJson(multiProjectRaw);
    const alpha = getProject(config, 'alpha');
    assert.equal(alpha.name, 'Alpha');
    assert.equal(alpha.bareRepoPath, '/tmp/alpha.git');
  });

  it('getProject throws for unknown id', () => {
    const config = loadConfigFromJson(multiProjectRaw);
    assert.throws(
      () => getProject(config, 'unknown-id'),
      (err: Error) => {
        assert.match(err.message, /Unknown project: "unknown-id"/);
        return true;
      },
    );
  });

  it('throws when a multi-project entry is missing bareRepoPath', () => {
    const raw = {
      server: { port: 9100 },
      projects: {
        good: { name: 'Good', path: '/tmp/good', bareRepoPath: '/tmp/good.git' },
        bad: { name: 'Bad', path: '/tmp/bad' },
      },
    };
    assert.throws(
      () => loadConfigFromJson(raw),
      (err: Error) => {
        assert.match(err.message, /projects\.bad\.bareRepoPath/);
        return true;
      },
    );
  });

  it('throws when a multi-project entry is missing path', () => {
    const raw = {
      server: { port: 9100 },
      projects: {
        good: { name: 'Good', path: '/tmp/good', bareRepoPath: '/tmp/good.git' },
        bad: { name: 'Bad', bareRepoPath: '/tmp/bad.git' },
      },
    };
    assert.throws(
      () => loadConfigFromJson(raw),
      (err: Error) => {
        assert.match(err.message, /projects\.bad\.path/);
        return true;
      },
    );
  });

  it('throws when a multi-project entry has testScriptPath but no scriptPath', () => {
    const raw = {
      server: { port: 9100 },
      projects: {
        good: { name: 'Good', path: '/tmp/good', bareRepoPath: '/tmp/good.git' },
        bad: {
          name: 'Bad',
          path: '/tmp/bad',
          bareRepoPath: '/tmp/bad.git',
          build: { testScriptPath: '/scripts/test.py' },
        },
      },
    };
    assert.throws(
      () => loadConfigFromJson(raw),
      (err: Error) => {
        assert.match(err.message, /projects\.bad\.build\.scriptPath/);
        return true;
      },
    );
  });

  it('throws when a project ID contains invalid characters', () => {
    const raw = {
      server: { port: 9100 },
      projects: {
        'valid-id': { name: 'Good', path: '/tmp/good', bareRepoPath: '/tmp/good.git' },
        'bad id!': { name: 'Bad', path: '/tmp/bad', bareRepoPath: '/tmp/bad.git' },
      },
    };
    assert.throws(
      () => loadConfigFromJson(raw),
      (err: Error) => {
        assert.match(err.message, /Invalid project ID "bad id!"/);
        return true;
      },
    );
  });

  it('ignores legacy fields when explicit projects block is present', () => {
    const raw = {
      ...validRaw,
      projects: {
        alpha: {
          name: 'Alpha',
          path: '/tmp/alpha',
          bareRepoPath: '/tmp/alpha.git',
        },
      },
    };
    const config = loadConfigFromJson(raw);
    const ids = Object.keys(config.resolvedProjects);
    assert.deepEqual(ids, ['alpha']);
    assert.equal(config.resolvedProjects['default'], undefined);
  });
});
