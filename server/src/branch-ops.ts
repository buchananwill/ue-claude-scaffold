/**
 * Branch operations for managing agent branches and seed branches in bare repos.
 *
 * All git operations use execFileSync with argument arrays — no shell interpolation.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { agentBranchFor, seedBranchFor } from './branch-naming.js';

export interface EnsureAgentBranchOpts {
  bareRepoPath: string;
  projectId: string;
  agentName: string;
  fresh: boolean;
  seedBranch?: string | null;
}

export interface EnsureAgentBranchResult {
  branch: string;
  sha: string;
  action: 'created' | 'reset' | 'resumed';
}

export interface BootstrapBareRepoOpts {
  bareRepoPath: string;
  projectPath: string;
  projectId: string;
  seedBranch?: string | null;
}

export interface BootstrapBareRepoResult {
  seedBranch: string;
  sha: string;
}

export interface MigrateLegacySeedBranchResult {
  migrated: boolean;
  oldBranch?: string;
  newBranch?: string;
}

/**
 * Resolve the SHA of the seed branch for a project in a bare repo.
 * Throws if the seed branch does not exist.
 */
export function seedBranchSha(bareRepoPath: string, projectId: string, projectConfig?: { seedBranch?: string | null }): string {
  const branch = seedBranchFor(projectId, projectConfig);
  const ref = `refs/heads/${branch}`;
  try {
    return execFileSync('git', ['rev-parse', '--verify', ref], {
      cwd: bareRepoPath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    throw new Error(`Seed branch "${branch}" does not exist in ${bareRepoPath}`);
  }
}

/**
 * Ensure an agent branch exists in the bare repo.
 *
 * - If `fresh`: reset agent branch to seed branch HEAD -> action: 'reset'
 * - If agent branch doesn't exist: create from seed branch -> action: 'created'
 * - If agent branch exists: resolve its SHA -> action: 'resumed'
 */
export function ensureAgentBranch(opts: EnsureAgentBranchOpts): EnsureAgentBranchResult {
  const { bareRepoPath, projectId, agentName, fresh, seedBranch } = opts;
  const branch = agentBranchFor(projectId, agentName);
  const agentRef = `refs/heads/${branch}`;
  const seedSha = seedBranchSha(bareRepoPath, projectId, seedBranch != null ? { seedBranch } : undefined);

  if (fresh) {
    // Check if agent branch already exists before resetting
    const existsCheck = spawnSync('git', ['rev-parse', '--verify', agentRef], {
      cwd: bareRepoPath,
      encoding: 'utf-8',
      timeout: 5000,
    });
    const existed = existsCheck.status === 0;

    // Create or reset agent branch to seed branch SHA
    execFileSync('git', ['update-ref', agentRef, seedSha], {
      cwd: bareRepoPath,
      timeout: 5000,
    });
    return { branch, sha: seedSha, action: existed ? 'reset' : 'created' };
  }

  // Check if agent branch exists
  const check = spawnSync('git', ['rev-parse', '--verify', agentRef], {
    cwd: bareRepoPath,
    encoding: 'utf-8',
    timeout: 5000,
  });

  if (check.status !== 0) {
    // Agent branch doesn't exist — create from seed
    execFileSync('git', ['update-ref', agentRef, seedSha], {
      cwd: bareRepoPath,
      timeout: 5000,
    });
    return { branch, sha: seedSha, action: 'created' };
  }

  // Agent branch exists — resume
  const sha = check.stdout.trim();
  return { branch, sha, action: 'resumed' };
}

/**
 * Check if a legacy seed branch (docker/current-root) exists and migrate
 * it to the new namespaced format (docker/{projectId}/current-root).
 */
export function migrateLegacySeedBranch(bareRepoPath: string, projectId: string): MigrateLegacySeedBranchResult {
  const oldBranch = 'docker/current-root';
  const newBranch = seedBranchFor(projectId);
  const oldRef = `refs/heads/${oldBranch}`;
  const newRef = `refs/heads/${newBranch}`;

  // Check if old branch exists
  const oldCheck = spawnSync('git', ['rev-parse', '--verify', oldRef], {
    cwd: bareRepoPath,
    encoding: 'utf-8',
    timeout: 5000,
  });

  if (oldCheck.status !== 0) {
    // Old branch doesn't exist — nothing to migrate
    return { migrated: false };
  }

  // Check if new branch already exists
  const newCheck = spawnSync('git', ['rev-parse', '--verify', newRef], {
    cwd: bareRepoPath,
    encoding: 'utf-8',
    timeout: 5000,
  });

  if (newCheck.status === 0) {
    // New branch already exists — nothing to migrate
    return { migrated: false };
  }

  // Copy old ref to new ref
  const oldSha = oldCheck.stdout.trim();
  execFileSync('git', ['update-ref', newRef, oldSha], {
    cwd: bareRepoPath,
    timeout: 5000,
  });

  return { migrated: true, oldBranch, newBranch };
}

/**
 * Clone a project as a bare repo and create the seed branch from HEAD.
 */
export function bootstrapBareRepo(opts: BootstrapBareRepoOpts): BootstrapBareRepoResult {
  const { bareRepoPath, projectPath, projectId, seedBranch: seedBranchOverride } = opts;

  if (existsSync(bareRepoPath)) {
    throw new Error(`Bare repo already exists at ${bareRepoPath}`);
  }

  // Clone as bare
  execFileSync('git', ['clone', '--bare', projectPath, bareRepoPath], {
    encoding: 'utf-8',
    timeout: 60_000,
  });

  // Create seed branch from HEAD
  const seedBranch = seedBranchFor(projectId, seedBranchOverride != null ? { seedBranch: seedBranchOverride } : undefined);
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: bareRepoPath,
    encoding: 'utf-8',
    timeout: 5000,
  }).trim();

  const seedRef = `refs/heads/${seedBranch}`;
  execFileSync('git', ['update-ref', seedRef, headSha], {
    cwd: bareRepoPath,
    timeout: 5000,
  });

  return { seedBranch, sha: headSha };
}
