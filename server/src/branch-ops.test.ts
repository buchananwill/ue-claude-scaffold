import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ensureAgentBranch,
  seedBranchSha,
  migrateLegacySeedBranch,
  bootstrapBareRepo,
} from './branch-ops.js';
import { seedBranchFor } from './branch-naming.js';

/**
 * Helper: create a temporary git repo with one commit, then clone it as bare.
 * Returns { sourceDir, bareDir, headSha }.
 */
function createTestRepos(): { sourceDir: string; bareDir: string; headSha: string; cleanup: () => void } {
  const base = mkdtempSync(path.join(tmpdir(), 'branch-ops-test-'));
  const sourceDir = path.join(base, 'source');
  const bareDir = path.join(base, 'bare.git');

  // Create source repo with one commit
  execFileSync('git', ['init', sourceDir], { timeout: 5000 });
  execFileSync('git', ['-C', sourceDir, 'config', 'user.email', 'test@test.com'], { timeout: 5000 });
  execFileSync('git', ['-C', sourceDir, 'config', 'user.name', 'Test'], { timeout: 5000 });
  execFileSync('git', ['-C', sourceDir, 'commit', '--allow-empty', '-m', 'initial'], { timeout: 5000 });

  const headSha = execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], {
    encoding: 'utf-8',
    timeout: 5000,
  }).trim();

  // Clone as bare
  execFileSync('git', ['clone', '--bare', sourceDir, bareDir], { timeout: 5000 });

  const cleanup = () => {
    rmSync(base, { recursive: true, force: true });
  };

  return { sourceDir, bareDir, headSha, cleanup };
}

/**
 * Helper: create a seed branch in a bare repo.
 */
function createSeedBranch(bareDir: string, projectId: string, sha: string): void {
  const seedBranch = seedBranchFor(projectId);
  execFileSync('git', ['update-ref', `refs/heads/${seedBranch}`, sha], {
    cwd: bareDir,
    timeout: 5000,
  });
}

describe('seedBranchSha', () => {
  let repos: ReturnType<typeof createTestRepos>;

  beforeEach(() => {
    repos = createTestRepos();
  });

  afterEach(() => {
    repos.cleanup();
  });

  it('returns the SHA of an existing seed branch', () => {
    createSeedBranch(repos.bareDir, 'myproject', repos.headSha);
    const sha = seedBranchSha(repos.bareDir, 'myproject');
    assert.equal(sha, repos.headSha);
  });

  it('throws if seed branch does not exist', () => {
    assert.throws(
      () => seedBranchSha(repos.bareDir, 'nonexistent'),
      /Seed branch.*does not exist/,
    );
  });

  it('returns the SHA when a custom seedBranch override is provided', () => {
    const customBranch = 'custom/seed-branch';
    // Create a branch with the custom name
    execFileSync('git', ['update-ref', `refs/heads/${customBranch}`, repos.headSha], {
      cwd: repos.bareDir,
      timeout: 5000,
    });

    const sha = seedBranchSha(repos.bareDir, 'myproject', { seedBranch: customBranch });
    assert.equal(sha, repos.headSha);
  });
});

describe('ensureAgentBranch', () => {
  let repos: ReturnType<typeof createTestRepos>;

  beforeEach(() => {
    repos = createTestRepos();
    createSeedBranch(repos.bareDir, 'proj1', repos.headSha);
  });

  afterEach(() => {
    repos.cleanup();
  });

  it('creates agent branch when it does not exist (fresh=false)', () => {
    const result = ensureAgentBranch({
      bareRepoPath: repos.bareDir,
      projectId: 'proj1',
      agentName: 'agent-1',
      fresh: false,
    });

    assert.equal(result.action, 'created');
    assert.equal(result.branch, 'docker/proj1/agent-1');
    assert.equal(result.sha, repos.headSha);

    // Verify the branch actually exists
    const sha = execFileSync('git', ['rev-parse', '--verify', 'refs/heads/docker/proj1/agent-1'], {
      cwd: repos.bareDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    assert.equal(sha, repos.headSha);
  });

  it('resumes existing agent branch (fresh=false)', () => {
    // Pre-create the agent branch
    execFileSync('git', ['update-ref', 'refs/heads/docker/proj1/agent-1', repos.headSha], {
      cwd: repos.bareDir,
      timeout: 5000,
    });

    const result = ensureAgentBranch({
      bareRepoPath: repos.bareDir,
      projectId: 'proj1',
      agentName: 'agent-1',
      fresh: false,
    });

    assert.equal(result.action, 'resumed');
    assert.equal(result.branch, 'docker/proj1/agent-1');
    assert.equal(result.sha, repos.headSha);
  });

  it('resets existing agent branch when fresh=true', () => {
    // Create a second commit so agent branch diverges from seed
    execFileSync('git', ['-C', repos.sourceDir, 'commit', '--allow-empty', '-m', 'second'], { timeout: 5000 });
    const newSha = execFileSync('git', ['-C', repos.sourceDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    // Point agent branch to the new commit (diverged from seed)
    execFileSync('git', ['-C', repos.bareDir, 'fetch', repos.sourceDir, `+${newSha}:refs/heads/docker/proj1/agent-1`], {
      timeout: 5000,
    });

    // Verify agent is at the new sha
    const beforeSha = execFileSync('git', ['rev-parse', 'refs/heads/docker/proj1/agent-1'], {
      cwd: repos.bareDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    assert.equal(beforeSha, newSha);

    // Now reset with fresh=true
    const result = ensureAgentBranch({
      bareRepoPath: repos.bareDir,
      projectId: 'proj1',
      agentName: 'agent-1',
      fresh: true,
    });

    assert.equal(result.action, 'reset');
    assert.equal(result.sha, repos.headSha); // Reset to seed SHA

    // Verify the branch was actually reset
    const afterSha = execFileSync('git', ['rev-parse', 'refs/heads/docker/proj1/agent-1'], {
      cwd: repos.bareDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    assert.equal(afterSha, repos.headSha);
  });

  it('creates agent branch when fresh=true and branch does not exist', () => {
    const result = ensureAgentBranch({
      bareRepoPath: repos.bareDir,
      projectId: 'proj1',
      agentName: 'fresh-new',
      fresh: true,
    });

    assert.equal(result.action, 'created');
    assert.equal(result.branch, 'docker/proj1/fresh-new');
    assert.equal(result.sha, repos.headSha);

    // Verify the branch actually exists
    const sha = execFileSync('git', ['rev-parse', '--verify', 'refs/heads/docker/proj1/fresh-new'], {
      cwd: repos.bareDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    assert.equal(sha, repos.headSha);
  });

  it('creates agent branch from a custom seedBranch override (fresh=false)', () => {
    const customBranch = 'custom/agent-seed';

    // Create the custom seed branch pointing at HEAD SHA — do NOT create the default seed
    execFileSync('git', ['update-ref', `refs/heads/${customBranch}`, repos.headSha], {
      cwd: repos.bareDir,
      timeout: 5000,
    });

    // Use a different projectId that has no default seed branch — proves the override is used
    const result = ensureAgentBranch({
      bareRepoPath: repos.bareDir,
      projectId: 'noseed',
      agentName: 'agent-custom',
      fresh: false,
      seedBranch: customBranch,
    });

    assert.equal(result.action, 'created');
    assert.equal(result.branch, 'docker/noseed/agent-custom');
    assert.equal(result.sha, repos.headSha);

    // Verify the agent branch SHA matches the custom seed's SHA
    const agentSha = execFileSync('git', ['rev-parse', '--verify', 'refs/heads/docker/noseed/agent-custom'], {
      cwd: repos.bareDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    assert.equal(agentSha, repos.headSha);
  });

  it('throws if seed branch does not exist', () => {
    assert.throws(
      () => ensureAgentBranch({
        bareRepoPath: repos.bareDir,
        projectId: 'no-such-project',
        agentName: 'agent-1',
        fresh: false,
      }),
      /Seed branch.*does not exist/,
    );
  });
});

describe('migrateLegacySeedBranch', () => {
  let repos: ReturnType<typeof createTestRepos>;

  beforeEach(() => {
    repos = createTestRepos();
  });

  afterEach(() => {
    repos.cleanup();
  });

  it('migrates docker/current-root to docker/{projectId}/current-root', () => {
    // Create legacy branch
    execFileSync('git', ['update-ref', 'refs/heads/docker/current-root', repos.headSha], {
      cwd: repos.bareDir,
      timeout: 5000,
    });

    const result = migrateLegacySeedBranch(repos.bareDir, 'myproj');

    assert.equal(result.migrated, true);
    assert.equal(result.oldBranch, 'docker/current-root');
    assert.equal(result.newBranch, 'docker/myproj/current-root');

    // Verify new branch exists with correct SHA
    const sha = execFileSync('git', ['rev-parse', 'refs/heads/docker/myproj/current-root'], {
      cwd: repos.bareDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    assert.equal(sha, repos.headSha);
  });

  it('returns migrated=false when legacy branch does not exist', () => {
    const result = migrateLegacySeedBranch(repos.bareDir, 'myproj');
    assert.equal(result.migrated, false);
  });

  it('returns migrated=false when new branch already exists', () => {
    // Create both branches
    execFileSync('git', ['update-ref', 'refs/heads/docker/current-root', repos.headSha], {
      cwd: repos.bareDir,
      timeout: 5000,
    });
    execFileSync('git', ['update-ref', 'refs/heads/docker/myproj/current-root', repos.headSha], {
      cwd: repos.bareDir,
      timeout: 5000,
    });

    const result = migrateLegacySeedBranch(repos.bareDir, 'myproj');
    assert.equal(result.migrated, false);
  });
});

describe('bootstrapBareRepo', () => {
  let base: string;
  let sourceDir: string;
  let headSha: string;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'bootstrap-test-'));
    sourceDir = path.join(base, 'source');

    // Create source repo
    execFileSync('git', ['init', sourceDir], { timeout: 5000 });
    execFileSync('git', ['-C', sourceDir, 'config', 'user.email', 'test@test.com'], { timeout: 5000 });
    execFileSync('git', ['-C', sourceDir, 'config', 'user.name', 'Test'], { timeout: 5000 });
    execFileSync('git', ['-C', sourceDir, 'commit', '--allow-empty', '-m', 'initial'], { timeout: 5000 });

    headSha = execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('clones project as bare repo and creates seed branch', () => {
    const bareDir = path.join(base, 'bare.git');
    const result = bootstrapBareRepo({
      bareRepoPath: bareDir,
      projectPath: sourceDir,
      projectId: 'testproj',
    });

    assert.equal(result.seedBranch, 'docker/testproj/current-root');
    assert.equal(result.sha, headSha);

    // Verify it's a bare repo
    const isBare = execFileSync('git', ['rev-parse', '--is-bare-repository'], {
      cwd: bareDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    assert.equal(isBare, 'true');

    // Verify seed branch exists
    const seedSha = execFileSync('git', ['rev-parse', 'refs/heads/docker/testproj/current-root'], {
      cwd: bareDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    assert.equal(seedSha, headSha);
  });

  it('throws if bare repo already exists', () => {
    const bareDir = path.join(base, 'bare.git');
    // Bootstrap once
    bootstrapBareRepo({
      bareRepoPath: bareDir,
      projectPath: sourceDir,
      projectId: 'testproj',
    });

    // Try again — should throw
    assert.throws(
      () => bootstrapBareRepo({
        bareRepoPath: bareDir,
        projectPath: sourceDir,
        projectId: 'testproj',
      }),
      /already exists/,
    );
  });

  it('uses a custom seedBranch override when provided', () => {
    const bareDir = path.join(base, 'custom-seed-bare.git');
    const result = bootstrapBareRepo({
      bareRepoPath: bareDir,
      projectPath: sourceDir,
      projectId: 'testproj',
      seedBranch: 'my/custom-root',
    });

    assert.equal(result.seedBranch, 'my/custom-root');
    assert.equal(result.sha, headSha);

    // Verify the custom-named branch exists in the bare repo
    const branchSha = execFileSync('git', ['rev-parse', 'refs/heads/my/custom-root'], {
      cwd: bareDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    assert.equal(branchSha, headSha);
  });
});
