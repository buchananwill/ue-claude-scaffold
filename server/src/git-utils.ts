import { execFileSync, spawnSync } from 'node:child_process';

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
