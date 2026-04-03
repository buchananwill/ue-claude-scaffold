import { execFileSync, spawnSync } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';
import { agentBranchFor, seedBranchFor, AGENT_NAME_RE, isValidAgentName } from './branch-naming.js';
import type { ScaffoldConfig, MergedProjectConfig } from './config.js';
import type { DrizzleDb } from './drizzle-instance.js';
import * as agentsQ from './queries/agents.js';

/**
 * Check whether a file path is committed (tracked in HEAD) at a given repo path.
 * Uses `git rev-parse HEAD:<path>` which succeeds only if the file is in the
 * latest commit — untracked or staged-but-uncommitted files will fail.
 */
export function isCommittedInRepo(repoPath: string, filePath: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `HEAD:${filePath}`], {
      cwd: repoPath,
      stdio: 'ignore',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a file path exists on a specific branch in a bare repo.
 * Uses `git cat-file -e <branch>:<path>`.
 */
export function existsInBareRepo(bareRepoPath: string, branch: string, filePath: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${branch}:${filePath}`], {
      cwd: bareRepoPath,
      stdio: 'ignore',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sync the exterior repo's HEAD into the bare repo's seed branch.
 * This is the core logic behind POST /sync/plans, extracted so task
 * creation endpoints can auto-sync before validating sourcePath.
 *
 * Returns { ok: true } if the sync succeeded (or was already up-to-date),
 * or { ok: false, reason } on failure.
 */
export function syncExteriorToBareRepo(
  exteriorRepo: string,
  bareRepo: string,
  seedBranch: string,
  log?: FastifyBaseLogger,
): { ok: true; exteriorHead: string; commitSha?: string } | { ok: false; reason: string } {
  const tempRef = '_sync/exterior';

  // Resolve exterior repo's HEAD
  let exteriorHead: string;
  try {
    exteriorHead = execFileSync('git', ['-C', exteriorRepo, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Failed to resolve HEAD in exterior repo: ${message}` };
  }

  // Fetch exterior HEAD into a temp branch in the bare repo
  try {
    execFileSync('git', [
      '-C', bareRepo, 'fetch', exteriorRepo,
      `+${exteriorHead}:refs/heads/${tempRef}`,
    ], { timeout: 30_000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Failed to fetch from exterior repo: ${message}` };
  }

  // Merge temp branch into seed branch
  let mergeResult: ReturnType<typeof mergeIntoBranch>;
  try {
    mergeResult = mergeIntoBranch(bareRepo, tempRef, seedBranch);
  } finally {
    // Clean up temp branch regardless of outcome
    try {
      execFileSync('git', ['-C', bareRepo, 'update-ref', '-d', `refs/heads/${tempRef}`], {
        timeout: 5000,
      });
    } catch { /* best effort */ }
  }

  if (!mergeResult.ok) {
    return { ok: false, reason: mergeResult.reason };
  }

  log?.info(`Auto-synced exterior repo (${exteriorHead.slice(0, 8)}) into ${seedBranch}`);
  return { ok: true, exteriorHead, commitSha: mergeResult.commitSha };
}

export function mergeIntoBranch(
  bareRepoPath: string,
  sourceBranch: string,
  targetBranch: string,
): { ok: true; commitSha?: string } | { ok: false; reason: string } {
  // 1. Check target branch exists
  const checkTarget = spawnSync('git', ['-C', bareRepoPath, 'rev-parse', '--verify', `refs/heads/${targetBranch}`], {
    encoding: 'utf-8', timeout: 5000,
  });
  if (checkTarget.status !== 0) {
    return { ok: false, reason: `branch ${targetBranch} does not exist` };
  }

  // 2. Resolve SHAs
  try {
    const sourceRef = execFileSync('git', ['-C', bareRepoPath, 'rev-parse', `refs/heads/${sourceBranch}`], {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
    const targetRef = execFileSync('git', ['-C', bareRepoPath, 'rev-parse', `refs/heads/${targetBranch}`], {
      encoding: 'utf-8', timeout: 5000,
    }).trim();

    // 3. Compute merge-base
    const mergeBase = spawnSync('git', ['-C', bareRepoPath, 'merge-base', sourceRef, targetRef], {
      encoding: 'utf-8', timeout: 5000,
    });

    if (mergeBase.status === 0) {
      const base = mergeBase.stdout.trim();

      // Already up-to-date (source is ancestor of target)
      if (base === sourceRef) {
        return { ok: true };
      }

      // Fast-forward possible (target is ancestor of source)
      if (base === targetRef) {
        execFileSync('git', ['-C', bareRepoPath, 'update-ref', `refs/heads/${targetBranch}`, sourceRef], { timeout: 5000 });
        return { ok: true, commitSha: sourceRef };
      }
    }

    // 4. True merge needed — use merge-tree (git >= 2.38)
    const mergeResult = spawnSync('git', [
      '-C', bareRepoPath, 'merge-tree', '--write-tree', targetRef, sourceRef,
    ], { encoding: 'utf-8', timeout: 10000 });

    if (mergeResult.status !== 0) {
      return { ok: false, reason: `merge conflict merging ${sourceBranch} into ${targetBranch}` };
    }

    const mergedTree = mergeResult.stdout.trim().split('\n')[0]; // First line is tree SHA
    const commitSha = execFileSync('git', [
      '-C', bareRepoPath, 'commit-tree', mergedTree,
      '-p', targetRef, '-p', sourceRef,
      '-m', `Merge ${sourceBranch} into ${targetBranch}`,
    ], { encoding: 'utf-8', timeout: 5000 }).trim();

    execFileSync('git', ['-C', bareRepoPath, 'update-ref', `refs/heads/${targetBranch}`, commitSha], { timeout: 5000 });
    return { ok: true, commitSha };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: message };
  }
}

/**
 * Resolve a list of target agents and merge the seed branch into each
 * agent's branch in the bare repo.
 *
 * `targetAgents` may be an explicit array of agent names or `'*'` to
 * target all active agents.
 *
 * Returns lists of successfully merged and failed agents.
 */
export async function mergeIntoAgentBranches(opts: {
  bareRepo: string;
  projectId: string;
  project: MergedProjectConfig;
  targetAgents: string[] | '*';
  db: DrizzleDb;
  log?: FastifyBaseLogger;
}): Promise<{ mergedAgents: string[]; failedMerges: Array<{ agent: string; reason: string }> }> {
  const { bareRepo, projectId, project, targetAgents, db, log } = opts;

  let agentNames: string[];
  if (targetAgents === '*') {
    agentNames = await agentsQ.getActiveNames(db);
  } else {
    agentNames = targetAgents;
  }

  const seedBranch = seedBranchFor(projectId, project);
  const mergedAgents: string[] = [];
  const failedMerges: Array<{ agent: string; reason: string }> = [];

  for (const agentName of agentNames) {
    if (!isValidAgentName(agentName)) {
      failedMerges.push({ agent: agentName, reason: 'Invalid agent name' });
      continue;
    }
    const targetBranch = agentBranchFor(projectId, agentName);
    const result = mergeIntoBranch(bareRepo, seedBranch, targetBranch);
    if (result.ok) {
      mergedAgents.push(agentName);
    } else {
      failedMerges.push({ agent: agentName, reason: result.reason });
      log?.warn(`Failed to merge ${seedBranch} into ${targetBranch}: ${result.reason}`);
    }
  }

  return { mergedAgents, failedMerges };
}
