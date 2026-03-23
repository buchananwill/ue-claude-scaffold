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

export function buildTreeWithFile(
  bareRepoPath: string,
  currentTreeSha: string | null,
  pathParts: string[],
  blobSha: string,
): string {
  if (pathParts.length === 1) {
    const fileName = pathParts[0];
    const entries: string[] = [];

    if (currentTreeSha) {
      const existing = execFileSync('git', ['-C', bareRepoPath, 'ls-tree', currentTreeSha], {
        encoding: 'utf-8', timeout: 5000,
      });
      for (const line of existing.split('\n').filter(Boolean)) {
        const entryName = line.split('\t')[1];
        if (entryName !== fileName) entries.push(line);
      }
    }

    entries.push(`100644 blob ${blobSha}\t${fileName}`);

    const mkTree = spawnSync('git', ['-C', bareRepoPath, 'mktree'], {
      input: entries.join('\n') + '\n',
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (mkTree.status !== 0) throw new Error(`git mktree failed: ${mkTree.stderr}`);
    return mkTree.stdout.trim();
  }

  const dirName = pathParts[0];
  const remaining = pathParts.slice(1);

  let subtreeSha: string | null = null;
  if (currentTreeSha) {
    try {
      const lsOutput = execFileSync('git', ['-C', bareRepoPath, 'ls-tree', currentTreeSha, '--', dirName], {
        encoding: 'utf-8', timeout: 5000,
      }).trim();
      if (lsOutput) {
        subtreeSha = lsOutput.split(/\s+/)[2];
      }
    } catch { /* directory doesn't exist yet */ }
  }

  const newSubtreeSha = buildTreeWithFile(bareRepoPath, subtreeSha, remaining, blobSha);

  const entries: string[] = [];
  if (currentTreeSha) {
    const existing = execFileSync('git', ['-C', bareRepoPath, 'ls-tree', currentTreeSha], {
      encoding: 'utf-8', timeout: 5000,
    });
    for (const line of existing.split('\n').filter(Boolean)) {
      const entryName = line.split('\t')[1];
      if (entryName !== dirName) entries.push(line);
    }
  }
  entries.push(`040000 tree ${newSubtreeSha}\t${dirName}`);

  const mkTree = spawnSync('git', ['-C', bareRepoPath, 'mktree'], {
    input: entries.join('\n') + '\n',
    encoding: 'utf-8',
    timeout: 5000,
  });
  if (mkTree.status !== 0) throw new Error(`git mktree failed: ${mkTree.stderr}`);
  return mkTree.stdout.trim();
}

/**
 * Write a file to a bare repo using git plumbing (no checkout needed).
 * Returns the commit SHA.
 */
export function writeContentToBareRepo(
  bareRepoPath: string,
  branch: string,
  filePath: string,
  content: string,
): string {
  // Step 1: Create blob from content
  const blobSha = spawnSync('git', ['-C', bareRepoPath, 'hash-object', '-w', '--stdin'], {
    input: content,
    encoding: 'utf-8',
    timeout: 10000,
  });
  if (blobSha.status !== 0) throw new Error(`git hash-object failed: ${blobSha.stderr}`);
  const blob = blobSha.stdout.trim();

  // Step 2: Get the current tree for the branch (if branch exists)
  let parentCommit: string | null = null;
  let rootTree: string | null = null;
  try {
    parentCommit = execFileSync('git', ['-C', bareRepoPath, 'rev-parse', `refs/heads/${branch}`], {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
    rootTree = execFileSync('git', ['-C', bareRepoPath, 'rev-parse', `${parentCommit}^{tree}`], {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
  } catch {
    // Branch doesn't exist yet — will create first commit without parent
  }

  // Step 3: Build tree with the new file — handle nested paths
  const parts = filePath.split('/');
  const newRootTree = buildTreeWithFile(bareRepoPath, rootTree, parts, blob);

  // Step 4: Create commit
  const commitArgs = ['-C', bareRepoPath, 'commit-tree', newRootTree, '-m', `Add plan: ${filePath}`];
  if (parentCommit) {
    commitArgs.splice(4, 0, '-p', parentCommit);
  }
  const commitSha = execFileSync('git', commitArgs, {
    encoding: 'utf-8', timeout: 5000,
  }).trim();

  // Step 5: Update branch ref
  execFileSync('git', ['-C', bareRepoPath, 'update-ref', `refs/heads/${branch}`, commitSha], {
    timeout: 5000,
  });

  return commitSha;
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
