import type { FastifyPluginAsync } from 'fastify';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { db } from '../db.js';
import type { ScaffoldConfig, ProjectConfig } from '../config.js';
import { getProject } from '../config.js';
import { isStale, recordBuildStart, recordBuildEnd } from './ubt.js';
import { ensureStagingPlugins } from '../staging-plugins.js';

interface BuildOpts {
  config: ScaffoldConfig;
}

interface SpawnResult {
  success: boolean;
  exit_code: number;
  output: string;
  stderr: string;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      resolve({
        success: code === 0,
        exit_code: code ?? 1,
        output: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      });
    });

    child.on('error', (err) => {
      resolve({
        success: false,
        exit_code: 1,
        output: '',
        stderr: err.message,
      });
    });
  });
}

export function isUbtContentionResult(result: SpawnResult): boolean {
  // UBT emits this when its internal mutex (Global\UnrealBuildTool_Mutex_*) is held by another process.
  // Two known message variants observed on Windows with UE 5.x:
  //   1. "A conflicting instance of Global\UnrealBuildTool_Mutex_... is already running."
  //   2. "...already set, indicating that a conflicting instance..."
  const combined = result.output + result.stderr;
  return combined.includes('conflicting instance') || combined.includes('ConflictingInstance');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithUbtRetry(
  thunk: () => Promise<SpawnResult>,
  maxRetries: number,
  delayMs: number,
): Promise<SpawnResult> {
  let result = await thunk();
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (!isUbtContentionResult(result)) {
      return result;
    }
    await sleep(delayMs);
    result = await thunk();
  }
  if (isUbtContentionResult(result)) {
    return {
      success: false,
      exit_code: -1,
      output: result.output,
      stderr: `UBT external lock contention after ${maxRetries} retries. Another process (IDE or interactive session) is holding the UBT mutex. The agent should wait and retry the build request rather than attempting to fix a code problem.`,
    };
  }
  return result;
}

const SCRIPT_INTERPRETERS: Record<string, string> = {
  '.py': 'python',
  '.sh': 'bash',
  '.rb': 'ruby',
};

/** Resolve a script path into an explicit interpreter + args to avoid shebang/CRLF issues. */
function resolveScript(scriptPath: string, extraArgs: string[]): { command: string; scriptArgs: string[] } {
  const ext = path.extname(scriptPath).toLowerCase();
  const interpreter = SCRIPT_INTERPRETERS[ext];
  if (interpreter) {
    return { command: interpreter, scriptArgs: [scriptPath, ...extraArgs] };
  }
  return { command: scriptPath, scriptArgs: extraArgs };
}

const buildPlugin: FastifyPluginAsync<BuildOpts> = async (fastify, opts) => {
  const config = opts.config;

  const getLockStmt = db.prepare("SELECT * FROM ubt_lock WHERE project_id = 'default'");
  const getAgentProject = db.prepare('SELECT project_id FROM agents WHERE name = ?');

  function resolveProjectIdForAgent(agentName: string | undefined): string {
    if (agentName) {
      const row = getAgentProject.get(agentName) as { project_id: string } | undefined;
      if (row) return row.project_id;
    }
    return 'default';
  }

  function resolveProjectForAgent(agentName: string | undefined): ProjectConfig {
    const projectId = resolveProjectIdForAgent(agentName);
    try {
      return getProject(config, projectId);
    } catch {
      throw Object.assign(new Error(`Unknown project: "${projectId}"`), { statusCode: 400 });
    }
  }

  function checkLock(agentName: string | undefined): string | null {
    const lock = getLockStmt.get() as { holder: string | null; acquired_at: string | null } | undefined;
    if (!lock || !lock.holder) {
      return null;
    }
    if (isStale(lock.acquired_at)) {
      return null;
    }
    if (lock.holder === agentName) {
      return null;
    }
    return lock.holder;
  }

  function getStagingWorktree(agentName: string | undefined, project: ProjectConfig): string {
    const worktreeRoot = project.stagingWorktreeRoot ?? config.server.stagingWorktreeRoot;
    if (worktreeRoot && agentName) {
      return path.join(worktreeRoot, agentName);
    }
    return project.path;
  }

  function getBareRepoPath(project: ProjectConfig): string {
    return project.bareRepoPath;
  }

  /** Ref used to track the last-synced commit in each staging worktree.
   *  We deliberately do NOT advance HEAD during sync — HEAD must lag behind
   *  so that `git status` shows the checked-out files as staged changes.
   *  UBT's adaptive non-unity build uses `git status` to determine its
   *  working set; if HEAD matches the working tree, UBT sees no changes
   *  and skips compilation entirely (the ~950ms false-success bug). */
  const SYNC_REF = 'refs/scaffold/last-sync';

  async function updateSyncRef(worktreePath: string): Promise<void> {
    const result = await runCommand('git', ['update-ref', SYNC_REF, 'FETCH_HEAD'], worktreePath, 5000);
    if (!result.success) {
      throw new Error(`syncWorktree: git update-ref failed: ${result.stderr}`);
    }
  }

  /** Sync the staging worktree from the agent's branch in the bare repo.
   *  Returns 'changed' if files were updated, 'unchanged' if nothing new.
   *  Throws on infrastructure failure (git errors the agent can't fix).
   *
   *  IMPORTANT: This function does NOT advance HEAD.  It tracks the last-synced
   *  commit via refs/scaffold/last-sync instead.  This keeps `git status` dirty
   *  so that UBT's `git status`-based change detection sees the new files. */
  async function syncWorktree(agentName: string | undefined, project: ProjectConfig): Promise<'changed' | 'unchanged'> {
    const worktreePath = getStagingWorktree(agentName, project);
    const bareRepo = getBareRepoPath(project);

    const agentRow = agentName
      ? (db.prepare('SELECT worktree FROM agents WHERE name = ?').get(agentName) as { worktree: string } | undefined)
      : undefined;
    const branch = agentRow?.worktree ?? 'docker/current-root';

    const fetchResult = await runCommand('git', ['fetch', bareRepo, branch], worktreePath, 30000);
    if (!fetchResult.success) {
      throw new Error(`syncWorktree: git fetch failed: ${fetchResult.stderr}`);
    }

    // Determine the base commit for the diff.  Use our custom tracking ref
    // if it exists, otherwise fall back to HEAD (first sync).
    const refCheck = await runCommand('git', ['rev-parse', '--verify', SYNC_REF], worktreePath, 5000);
    const baseRef = refCheck.success ? SYNC_REF : 'HEAD';

    // Diff-based sync: only touch files that actually changed.
    // This preserves timestamps on unchanged files so UBT's incremental
    // build cache stays valid (a full `reset --hard` rewrites every file's
    // mtime, forcing a near-full rebuild every time).
    //
    // We split the diff into added/modified vs deleted files because
    // `git checkout FETCH_HEAD -- <deleted-file>` fails (the file doesn't
    // exist in FETCH_HEAD), which previously caused a fallback to
    // `reset --hard` and killed caching entirely.

    // Files added or modified in FETCH_HEAD — need to be checked out.
    const addModResult = await runCommand(
      'git', ['diff', '--name-only', '--diff-filter=AMCR', baseRef, 'FETCH_HEAD'], worktreePath, 15000,
    );

    // Files deleted in FETCH_HEAD — need to be removed from the worktree.
    const delResult = await runCommand(
      'git', ['diff', '--name-only', '--diff-filter=D', baseRef, 'FETCH_HEAD'], worktreePath, 15000,
    );

    if (!addModResult.success || !delResult.success) {
      // If diff fails (e.g. first sync with no HEAD), fall back to hard reset.
      const resetResult = await runCommand('git', ['reset', '--hard', 'FETCH_HEAD'], worktreePath, 30000);
      if (!resetResult.success) {
        throw new Error(`syncWorktree: git reset --hard failed: ${resetResult.stderr}`);
      }
      await updateSyncRef(worktreePath);
      return 'changed';
    }

    const addModFiles = addModResult.output.trim();
    const delFiles = delResult.output.trim();

    if (addModFiles.length === 0 && delFiles.length === 0) {
      // No files changed — update the tracking ref only.
      await updateSyncRef(worktreePath);
      return 'unchanged';
    }

    // Remove deleted files from the worktree.
    if (delFiles.length > 0) {
      const rmResult = await runCommand(
        'git', ['rm', '--quiet', '--force', '--', ...delFiles.split('\n')], worktreePath, 15000,
      );
      if (!rmResult.success) {
        // Non-fatal: files may already be gone. Proceed with checkout.
      }
    }

    // Checkout added/modified files from FETCH_HEAD.
    // `git checkout FETCH_HEAD -- <files>` updates both working tree and index.
    // Since HEAD has NOT been advanced, `git status` will show these files as
    // staged changes — exactly what UBT needs to detect modified sources.
    if (addModFiles.length > 0) {
      const checkoutResult = await runCommand(
        'git', ['checkout', 'FETCH_HEAD', '--', ...addModFiles.split('\n')], worktreePath, 30000,
      );
      if (!checkoutResult.success) {
        // Last resort — hard reset. This should be rare now.
        const resetResult = await runCommand('git', ['reset', '--hard', 'FETCH_HEAD'], worktreePath, 30000);
        if (!resetResult.success) {
          throw new Error(`syncWorktree: git reset --hard failed: ${resetResult.stderr}`);
        }
        await updateSyncRef(worktreePath);
        return 'changed';
      }
    }

    // Record what we synced — but do NOT advance HEAD.
    await updateSyncRef(worktreePath);

    return 'changed';
  }

  fastify.post<{
    Body: { clean?: boolean };
  }>('/build', async (request) => {
    const agentName = request.headers['x-agent-name'] as string | undefined;
    const project = resolveProjectForAgent(agentName);
    const projectId = resolveProjectIdForAgent(agentName);
    const holder = checkLock(agentName);
    if (holder) {
      return {
        success: false,
        exit_code: -1,
        output: '',
        stderr: `UBT lock held by '${holder}'. The build hook should have acquired the lock first — this is unexpected.`,
      };
    }

    try {
      await syncWorktree(agentName, project);
    } catch (err) {
      return {
        success: false,
        exit_code: -1,
        output: '',
        stderr: `Infrastructure error: ${(err as Error).message}. Agent should shut down.`,
      };
    }

    // Ensure per-worktree plugin copies exist (replaces junctions with hard copies
    // so each agent maintains its own UBT intermediate cache).
    await ensureStagingPlugins(getStagingWorktree(agentName, project), config);

    const args = ['--summary'];
    if (request.body.clean) {
      args.push('--clean');
    }

    const scriptPath = project.build?.scriptPath ?? config.build.scriptPath;
    const cwd = getStagingWorktree(agentName, project);
    const { command, scriptArgs } = resolveScript(scriptPath, args);

    const buildTimeoutMs = project.build?.buildTimeoutMs ?? config.build.buildTimeoutMs;
    const agentForHistory = agentName ?? 'unknown';
    const histId = recordBuildStart(agentForHistory, 'build', projectId);
    const t0 = Date.now();
    const result = await runWithUbtRetry(
      () => runCommand(command, scriptArgs, cwd, buildTimeoutMs),
      config.build.ubtRetryCount,
      config.build.ubtRetryDelayMs,
    );
    recordBuildEnd(histId, Date.now() - t0, result.success, result.output, result.stderr);
    return result;
  });

  fastify.post<{
    Body: { filters?: string[] };
  }>('/test', async (request) => {
    const agentName = request.headers['x-agent-name'] as string | undefined;
    const project = resolveProjectForAgent(agentName);
    const projectId = resolveProjectIdForAgent(agentName);
    const holder = checkLock(agentName);
    if (holder) {
      return {
        success: false,
        exit_code: -1,
        output: '',
        stderr: `UBT lock held by '${holder}'. The build hook should have acquired the lock first — this is unexpected.`,
      };
    }

    try {
      await syncWorktree(agentName, project);
    } catch (err) {
      return {
        success: false,
        exit_code: -1,
        output: '',
        stderr: `Infrastructure error: ${(err as Error).message}. Agent should shut down.`,
      };
    }

    await ensureStagingPlugins(getStagingWorktree(agentName, project), config);

    const filters = request.body.filters?.length
      ? request.body.filters
      : config.build.defaultTestFilters;

    const scriptPath = project.build?.testScriptPath ?? config.build.testScriptPath;
    const cwd = getStagingWorktree(agentName, project);
    const { command, scriptArgs } = resolveScript(scriptPath, filters);

    const testTimeoutMs = project.build?.testTimeoutMs ?? config.build.testTimeoutMs;
    const agentForHistory = agentName ?? 'unknown';
    const histId = recordBuildStart(agentForHistory, 'test', projectId);
    const t0 = Date.now();
    const result = await runWithUbtRetry(
      () => runCommand(command, scriptArgs, cwd, testTimeoutMs),
      config.build.ubtRetryCount,
      config.build.ubtRetryDelayMs,
    );
    recordBuildEnd(histId, Date.now() - t0, result.success, result.output, result.stderr);
    return result;
  });
};

export default buildPlugin;
