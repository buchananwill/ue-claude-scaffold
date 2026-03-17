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
      shell: true,
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

  function getStagingWorktree(): string {
    return config.server.stagingWorktreePath ?? config.project.path;
  }

  function getBareRepoPath(): string {
    return config.server.bareRepoPath ?? path.join(config.project.path, '..', 'repo.git');
  }

  async function syncWorktree(agentName: string | undefined): Promise<SpawnResult | null> {
    const worktreePath = getStagingWorktree();
    const bareRepo = getBareRepoPath();

    const agentRow = agentName
      ? (db.prepare('SELECT worktree FROM agents WHERE name = ?').get(agentName) as { worktree: string } | undefined)
      : undefined;
    const branch = agentRow?.worktree ?? 'main';

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
    const cwd = getStagingWorktree();

    const agentForHistory = agentName ?? 'unknown';
    const histId = recordBuildStart(agentForHistory, 'build');
    const t0 = Date.now();
    const result = await runCommand(scriptPath, args, cwd, 660_000);
    recordBuildEnd(histId, Date.now() - t0, result.success);
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
    const cwd = getStagingWorktree();

    const agentForHistory = agentName ?? 'unknown';
    const histId = recordBuildStart(agentForHistory, 'test');
    const t0 = Date.now();
    const result = await runCommand(scriptPath, filters, cwd, 700_000);
    recordBuildEnd(histId, Date.now() - t0, result.success);
    return result;
  });
};

export default buildPlugin;
