import { execFileSync } from "node:child_process";
import type { FastifyBaseLogger } from "fastify";

/**
 * Check whether a file path is committed (tracked in HEAD) at a given repo path.
 * Uses `git rev-parse HEAD:<path>` which succeeds only if the file is in the
 * latest commit — untracked or staged-but-uncommitted files will fail.
 */
export function isCommittedInRepo(repoPath: string, filePath: string): boolean {
  try {
    execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `HEAD:${filePath}`],
      {
        cwd: repoPath,
        stdio: "ignore",
        timeout: 5000,
      },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a file path exists on a specific branch in a bare repo.
 * Uses `git cat-file -e <branch>:<path>`.
 */
export function existsInBareRepo(
  bareRepoPath: string,
  branch: string,
  filePath: string,
): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${branch}:${filePath}`], {
      cwd: bareRepoPath,
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Force-set the bare repo's seed branch to the exterior repo's HEAD.
 *
 * This is the core logic behind POST /sync/plans. The seed branch
 * (docker/<project>/current-root) becomes byte-identical to the exterior repo's
 * HEAD commit — no merge, no fast-forward decision tree. If the exterior has
 * been rewound or rewritten, the seed follows.
 *
 * Only the seed branch is mutated. Agent branches are touched exclusively by
 * `--fresh` at container launch.
 */
export function syncExteriorToBareRepo(
  exteriorRepo: string,
  bareRepo: string,
  seedBranch: string,
  log?: FastifyBaseLogger,
):
  | { ok: true; exteriorHead: string; previousSeed: string | null }
  | { ok: false; reason: string } {
  let exteriorHead: string;
  try {
    exteriorHead = execFileSync(
      "git",
      ["-C", exteriorRepo, "rev-parse", "HEAD"],
      {
        encoding: "utf-8",
        timeout: 5000,
      },
    ).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `Failed to resolve HEAD in exterior repo: ${message}`,
    };
  }

  try {
    execFileSync("git", ["-C", bareRepo, "fetch", exteriorRepo, exteriorHead], {
      timeout: 30_000,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `Failed to fetch from exterior repo: ${message}`,
    };
  }

  let previousSeed: string | null = null;
  try {
    previousSeed = execFileSync(
      "git",
      [
        "-C",
        bareRepo,
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${seedBranch}`,
      ],
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
  } catch {
    previousSeed = null;
  }

  try {
    execFileSync(
      "git",
      ["-C", bareRepo, "update-ref", `refs/heads/${seedBranch}`, exteriorHead],
      { timeout: 5000 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Failed to update ${seedBranch}: ${message}` };
  }

  log?.info(
    `Forced ${seedBranch} to exterior HEAD ${exteriorHead.slice(0, 8)} ` +
      `(was ${previousSeed ? previousSeed.slice(0, 8) : "<none>"})`,
  );
  return { ok: true, exteriorHead, previousSeed };
}
