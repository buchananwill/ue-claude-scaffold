import type { FastifyBaseLogger } from 'fastify';
import type { ScaffoldConfig, MergedProjectConfig } from './config.js';
import { existsInBareRepo, isCommittedInRepo, syncExteriorToBareRepo } from './git-utils.js';
import { seedBranchFor } from './branch-naming.js';
import type { DrizzleDb } from './drizzle-instance.js';
import { resolveProject } from './resolve-project.js';

/**
 * Validate that a sourcePath exists in the bare repo (or worktree).
 * Performs auto-sync from the exterior repo on first miss when `autoSync` is true.
 *
 * Returns `{ valid: true }` if the path is found (or no bare repo is configured),
 * or `{ valid: false, message }` with a user-facing error message.
 */
export async function validateSourcePath(opts: {
  sourcePath: string;
  projectId: string;
  config: ScaffoldConfig;
  db: DrizzleDb;
  log?: FastifyBaseLogger;
  /** When true, attempt auto-sync from the exterior repo before rejecting. */
  autoSync?: boolean;
  /** Label for error messages (e.g. "Task 3"). Omit for single-task context. */
  label?: string;
}): Promise<{ valid: true; synced: boolean } | { valid: false; message: string; code: 400 | 422; synced: boolean }> {
  const { sourcePath, projectId, config, db, log, autoSync, label } = opts;
  const prefix = label ? `${label}: ` : '';

  // Path traversal check
  if (sourcePath.includes('..') || sourcePath.startsWith('/') || sourcePath === '') {
    return { valid: false, message: `${prefix}Invalid sourcePath: ${sourcePath}`, code: 400, synced: false };
  }

  let project: MergedProjectConfig;
  try {
    project = await resolveProject(config, db, projectId);
  } catch {
    return { valid: false, message: `${prefix}Unknown project: "${projectId}"`, code: 400, synced: false };
  }

  let synced = false;
  const bareRepo = project.bareRepoPath;
  if (bareRepo) {
    const seedBranch = seedBranchFor(projectId, project);
    if (!existsInBareRepo(bareRepo, seedBranch, sourcePath)) {
      // Auto-sync from exterior repo before rejecting
      if (autoSync) {
        const exteriorRepo = project.path;
        if (exteriorRepo) {
          const syncResult = syncExteriorToBareRepo(exteriorRepo, bareRepo, seedBranch, log);
          synced = true;
          if (!syncResult.ok) {
            log?.warn({ reason: syncResult.reason }, 'Auto-sync from exterior repo failed');
          }
        }
      }
      // Re-check after sync (or first check if autoSync is false)
      if (!existsInBareRepo(bareRepo, seedBranch, sourcePath)) {
        return {
          valid: false,
          message: `${prefix}sourcePath '${sourcePath}' not found on branch '${seedBranch}' in bare repo. Commit the plan in the exterior repo and retry.`,
          code: 422,
          synced,
        };
      }
    }
  } else {
    const worktree = project.path;
    if (!isCommittedInRepo(worktree, sourcePath)) {
      return {
        valid: false,
        message: `${prefix}sourcePath '${sourcePath}' is not committed in the project worktree (${worktree}). Commit it first: git add ${sourcePath} && git commit`,
        code: 422,
        synced: false,
      };
    }
  }

  return { valid: true, synced };
}
