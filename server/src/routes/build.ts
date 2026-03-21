import type { FastifyPluginAsync } from 'fastify';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { db } from '../db.js';
import type { ScaffoldConfig } from '../config.js';
import { isStale, recordBuildStart, recordBuildEnd } from './ubt.js';

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
  const marker = 'already set, indicating that a conflicting instance';
  return result.output.includes(marker) || result.stderr.includes(marker);
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

  const getLock = db.prepare('SELECT * FROM ubt_lock WHERE id = 1');

  function checkLock(agentName: string | undefined): string | null {
    const lock = getLock.get() as { holder: string | null; acquired_at: string | null } | undefined;
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

  function getStagingWorktree(agentName: string | undefined): string {
    if (config.server.stagingWorktreeRoot && agentName) {
      return path.join(config.server.stagingWorktreeRoot, agentName);
    }
    return config.project.path;
  }

  function getBareRepoPath(): string {
    return config.server.bareRepoPath;
  }

  async function syncWorktree(agentName: string | undefined): Promise<SpawnResult | null> {
    const worktreePath = getStagingWorktree(agentName);
    const bareRepo = getBareRepoPath();

    const agentRow = agentName
      ? (db.prepare('SELECT worktree FROM agents WHERE name = ?').get(agentName) as { worktree: string } | undefined)
      : undefined;
    const branch = agentRow?.worktree ?? 'docker/current-root';

    const fetchResult = await runCommand('git', ['fetch', bareRepo, branch], worktreePath, 30000);
    if (!fetchResult.success) {
      return {
        success: false,
        exit_code: fetchResult.exit_code,
        output: fetchResult.output,
        stderr: `syncWorktree: git fetch failed: ${fetchResult.stderr}`,
      };
    }

    const resetResult = await runCommand('git', ['reset', '--hard', 'FETCH_HEAD'], worktreePath, 30000);
    if (!resetResult.success) {
      return {
        success: false,
        exit_code: resetResult.exit_code,
        output: resetResult.output,
        stderr: `syncWorktree: git reset --hard failed: ${resetResult.stderr}`,
      };
    }

    return null;
  }

  fastify.post<{
    Body: { clean?: boolean };
  }>('/build', async (request) => {
    const agentName = request.headers['x-agent-name'] as string | undefined;
    const holder = checkLock(agentName);
    if (holder) {
      return {
        success: false,
        exit_code: -1,
        output: '',
        stderr: `UBT lock held by '${holder}'. The build hook should have acquired the lock first — this is unexpected.`,
      };
    }

    const syncError = await syncWorktree(agentName);
    if (syncError) {
      return syncError;
    }

    const args = ['--summary'];
    if (request.body.clean) {
      args.push('--clean');
    }

    const scriptPath = config.build.scriptPath;
    const cwd = getStagingWorktree(agentName);
    const { command, scriptArgs } = resolveScript(scriptPath, args);

    const agentForHistory = agentName ?? 'unknown';
    const histId = recordBuildStart(agentForHistory, 'build');
    const t0 = Date.now();
    const result = await runWithUbtRetry(
      () => runCommand(command, scriptArgs, cwd, config.build.buildTimeoutMs),
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
    const holder = checkLock(agentName);
    if (holder) {
      return {
        success: false,
        exit_code: -1,
        output: '',
        stderr: `UBT lock held by '${holder}'. The build hook should have acquired the lock first — this is unexpected.`,
      };
    }

    const syncError = await syncWorktree(agentName);
    if (syncError) {
      return syncError;
    }

    const filters = request.body.filters?.length
      ? request.body.filters
      : config.build.defaultTestFilters;

    const scriptPath = config.build.testScriptPath;
    const cwd = getStagingWorktree(agentName);
    const { command, scriptArgs } = resolveScript(scriptPath, filters);

    const agentForHistory = agentName ?? 'unknown';
    const histId = recordBuildStart(agentForHistory, 'test');
    const t0 = Date.now();
    const result = await runWithUbtRetry(
      () => runCommand(command, scriptArgs, cwd, config.build.testTimeoutMs),
      config.build.ubtRetryCount,
      config.build.ubtRetryDelayMs,
    );
    recordBuildEnd(histId, Date.now() - t0, result.success, result.output, result.stderr);
    return result;
  });
};

export default buildPlugin;
