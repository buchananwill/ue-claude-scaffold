import type { FastifyPluginAsync } from 'fastify';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ScaffoldConfig, ProjectConfig } from '../config.js';
import { getProject } from '../config.js';
import { isStale, recordBuildStart, recordBuildEnd } from './ubt.js';
import { ensureStagingPlugins } from '../staging-plugins.js';
import { getDb } from '../drizzle-instance.js';
import * as agentsQ from '../queries/agents.js';
import * as projectsQ from '../queries/projects.js';
import * as ubtQ from '../queries/ubt.js';
import { seedBranchFor } from '../branch-naming.js';

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

  async function resolveProjectIdForAgent(agentName: string | undefined): Promise<string> {
    if (agentName) {
      return agentsQ.getProjectId(getDb(), agentName);
    }
    return 'default';
  }

  async function resolveProjectForAgent(agentName: string | undefined): Promise<ProjectConfig> {
    const projectId = await resolveProjectIdForAgent(agentName);
    try {
      const dbRow = await projectsQ.getById(getDb(), projectId);
      return getProject(config, projectId, dbRow ?? undefined);
    } catch {
      throw Object.assign(new Error(`Unknown project: "${projectId}"`), { statusCode: 400 });
    }
  }

  async function checkLock(agentName: string | undefined, projectId: string): Promise<string | null> {
    const lock = await ubtQ.getLock(getDb(), projectId);
    if (!lock || !lock.holder) {
      return null;
    }
    if (isStale(lock.acquiredAt ? lock.acquiredAt.toISOString() : null)) {
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

  const SYNC_REF = 'refs/scaffold/last-sync';

  async function updateSyncRef(worktreePath: string): Promise<void> {
    const result = await runCommand('git', ['update-ref', SYNC_REF, 'FETCH_HEAD'], worktreePath, 5000);
    if (!result.success) {
      throw new Error(`syncWorktree: git update-ref failed: ${result.stderr}`);
    }
  }

  async function syncWorktree(agentName: string | undefined, project: ProjectConfig): Promise<'changed' | 'unchanged'> {
    const worktreePath = getStagingWorktree(agentName, project);
    const bareRepo = getBareRepoPath(project);

    const projectId = await resolveProjectIdForAgent(agentName);
    const dbRow = await projectsQ.getById(getDb(), projectId);
    const proj = getProject(config, projectId, dbRow ?? undefined);
    let branch = seedBranchFor(projectId, proj);
    if (agentName) {
      const agentRow = await agentsQ.getWorktreeInfo(getDb(), agentName);
      if (agentRow?.worktree) {
        branch = agentRow.worktree;
      }
    }

    const fetchResult = await runCommand('git', ['fetch', bareRepo, branch], worktreePath, 30000);
    if (!fetchResult.success) {
      throw new Error(`syncWorktree: git fetch failed: ${fetchResult.stderr}`);
    }

    const refCheck = await runCommand('git', ['rev-parse', '--verify', SYNC_REF], worktreePath, 5000);
    const baseRef = refCheck.success ? SYNC_REF : 'HEAD';

    const addModResult = await runCommand(
      'git', ['diff', '--name-only', '--diff-filter=AMCR', baseRef, 'FETCH_HEAD'], worktreePath, 15000,
    );

    const delResult = await runCommand(
      'git', ['diff', '--name-only', '--diff-filter=D', baseRef, 'FETCH_HEAD'], worktreePath, 15000,
    );

    if (!addModResult.success || !delResult.success) {
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
      await updateSyncRef(worktreePath);
      return 'unchanged';
    }

    if (delFiles.length > 0) {
      await runCommand(
        'git', ['rm', '--quiet', '--force', '--', ...delFiles.split('\n')], worktreePath, 15000,
      );
    }

    if (addModFiles.length > 0) {
      const checkoutResult = await runCommand(
        'git', ['checkout', 'FETCH_HEAD', '--', ...addModFiles.split('\n')], worktreePath, 30000,
      );
      if (!checkoutResult.success) {
        const resetResult = await runCommand('git', ['reset', '--hard', 'FETCH_HEAD'], worktreePath, 30000);
        if (!resetResult.success) {
          throw new Error(`syncWorktree: git reset --hard failed: ${resetResult.stderr}`);
        }
        await updateSyncRef(worktreePath);
        return 'changed';
      }
    }

    await updateSyncRef(worktreePath);

    return 'changed';
  }

  fastify.post<{
    Body: { clean?: boolean };
  }>('/build', async (request) => {
    // NOTE: x-agent-name is trusted without authentication. This relies on
    // network-isolated deployment (containers on the same host). If the server
    // is exposed to untrusted networks, agent identity must be authenticated.
    const agentName = request.headers['x-agent-name'] as string | undefined;
    if (agentName && !/^[a-zA-Z0-9_-]{1,64}$/.test(agentName)) {
      return {
        success: false,
        exit_code: -1,
        output: '',
        stderr: 'Invalid X-Agent-Name header format',
      };
    }
    const project = await resolveProjectForAgent(agentName);
    const projectId = await resolveProjectIdForAgent(agentName);
    const holder = await checkLock(agentName, projectId);
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

    const args = ['--summary'];
    if (request.body.clean) {
      args.push('--clean');
    }

    const scriptPath = project.build?.scriptPath ?? config.build.scriptPath;
    const cwd = getStagingWorktree(agentName, project);
    const { command, scriptArgs } = resolveScript(scriptPath, args);

    const buildTimeoutMs = project.build?.buildTimeoutMs ?? config.build.buildTimeoutMs;
    const agentForHistory = agentName ?? 'unknown';
    const histId = await recordBuildStart(agentForHistory, 'build', projectId);
    const t0 = Date.now();
    const result = await runWithUbtRetry(
      () => runCommand(command, scriptArgs, cwd, buildTimeoutMs),
      config.build.ubtRetryCount,
      config.build.ubtRetryDelayMs,
    );
    await recordBuildEnd(histId, Date.now() - t0, result.success, result.output, result.stderr);
    return result;
  });

  fastify.post<{
    Body: { filters?: string[] };
  }>('/test', async (request) => {
    const agentName = request.headers['x-agent-name'] as string | undefined;
    if (agentName && !/^[a-zA-Z0-9_-]{1,64}$/.test(agentName)) {
      return {
        success: false,
        exit_code: -1,
        output: '',
        stderr: 'Invalid X-Agent-Name header format',
      };
    }
    const project = await resolveProjectForAgent(agentName);
    const projectId = await resolveProjectIdForAgent(agentName);
    const holder = await checkLock(agentName, projectId);
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
    const histId = await recordBuildStart(agentForHistory, 'test', projectId);
    const t0 = Date.now();
    const result = await runWithUbtRetry(
      () => runCommand(command, scriptArgs, cwd, testTimeoutMs),
      config.build.ubtRetryCount,
      config.build.ubtRetryDelayMs,
    );
    await recordBuildEnd(histId, Date.now() - t0, result.success, result.output, result.stderr);
    return result;
  });
};

export default buildPlugin;
