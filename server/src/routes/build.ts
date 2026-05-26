import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { killTree } from "../process-utils.js";
import { registerBuild, unregisterBuild } from "../build-registry.js";
import type { ScaffoldConfig, ProjectConfig } from "../config.js";
import { getProject } from "../config.js";
import { isStale, recordBuildStart, recordBuildEnd } from "./ubt.js";
import { ensureStagingPlugins } from "../staging-plugins.js";
import { getDb } from "../drizzle-instance.js";
import * as agentsQ from "../queries/agents.js";
import * as projectsQ from "../queries/projects.js";
import * as ubtQ from "../queries/ubt.js";
import { seedBranchFor, AGENT_NAME_RE } from "../branch-naming.js";
import { resolveProject } from "../resolve-project.js";
import { resolveAgent } from "./route-helpers.js";

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
  onSpawn?: (child: ChildProcess) => void,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    // Recursion guard: the host-side build/test scripts (Scripts/build.py,
    // Scripts/run_tests.py) forward to this server when SCAFFOLD_FORWARD_SCRIPT is set.
    // Strip it from the child environment so the scripts we spawn here run locally
    // instead of forwarding back to us. Inheritance is transitive, so this also covers
    // run_tests.py's internal pre-test build.py.
    const childEnv = { ...process.env };
    delete childEnv.SCAFFOLD_FORWARD_SCRIPT;
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    onSpawn?.(child);

    // Node's own spawn `timeout` only signals the direct child, orphaning the
    // UE compiler grandchildren. Enforce the ceiling ourselves with a tree-kill
    // so the whole process tree dies when a build genuinely hangs.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid != null) killTree(child.pid);
    }, timeoutMs);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("close", (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      resolve({
        success: !timedOut && code === 0,
        exit_code: timedOut ? -1 : (code ?? 1),
        output: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: timedOut
          ? `${stderr}\n[killed: build exceeded ${timeoutMs}ms and was terminated]`
          : stderr,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        exit_code: 1,
        output: "",
        stderr: err.message,
      });
    });
  });
}

export function isUbtContentionResult(result: SpawnResult): boolean {
  const combined = result.output + result.stderr;
  return (
    combined.includes("conflicting instance") ||
    combined.includes("ConflictingInstance")
  );
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
  ".py": "python",
  ".sh": "bash",
  ".rb": "ruby",
};

/** Resolve a script path into an explicit interpreter + args to avoid shebang/CRLF issues. */
function resolveScript(
  scriptPath: string,
  extraArgs: string[],
): { command: string; scriptArgs: string[] } {
  const ext = path.extname(scriptPath).toLowerCase();
  const interpreter = SCRIPT_INTERPRETERS[ext];
  if (interpreter) {
    return { command: interpreter, scriptArgs: [scriptPath, ...extraArgs] };
  }
  return { command: scriptPath, scriptArgs: extraArgs };
}

export interface TestRequestBody {
  filters?: string[];
  withRhi?: boolean;
  functional?: boolean;
  timeout?: number | null;
  noBuild?: boolean;
  keepLog?: boolean;
  // Present because the transport script posts the script's payload verbatim; ignored
  // here (the route already determines the operation).
  operation?: string;
  // Transitional legacy field: the old PreToolUse hook posted pre-split CLI tokens.
  // Removed once the script-side routing cutover is complete.
  flags?: string[];
}

export function buildTestScriptArgs(
  body: TestRequestBody,
  defaultFilters: string[],
): string[] {
  const resolvedFilters = body.filters?.length ? body.filters : defaultFilters;

  // Legacy path: the hook already produced an ordered CLI token list.
  if (body.flags) {
    return [...body.flags, ...resolvedFilters];
  }

  // Structured path: reconstruct a canonical argv. Flags first (each emitted only when
  // set), then positional filters — so --timeout is always immediately followed by its
  // value and run_tests.py's argparse (flags then nargs="*" filters) parses cleanly.
  const args: string[] = [];
  if (body.withRhi) args.push("--with-rhi");
  if (body.functional) args.push("--functional");
  if (body.timeout != null) args.push("--timeout", String(body.timeout));
  if (body.noBuild) args.push("--no-build");
  if (body.keepLog) args.push("--keep-log");
  args.push(...resolvedFilters);
  return args;
}

const BUILD_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    operation: { type: "string" },
    clean: { type: "boolean" },
  },
};

const TEST_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    operation: { type: "string" },
    filters: { type: "array", items: { type: "string" } },
    withRhi: { type: "boolean" },
    functional: { type: "boolean" },
    timeout: { type: ["number", "null"] },
    noBuild: { type: "boolean" },
    keepLog: { type: "boolean" },
    // Transitional legacy field; removed with the old hook.
    flags: { type: "array", items: { type: "string" } },
  },
};

const buildPlugin: FastifyPluginAsync<BuildOpts> = async (fastify, opts) => {
  const config = opts.config;

  async function resolveProjectForAgent(
    projectId: string,
  ): Promise<{ project: ProjectConfig; projectId: string }> {
    try {
      const project = await resolveProject(config, getDb(), projectId);
      return { project, projectId };
    } catch {
      throw Object.assign(new Error(`Unknown project: "${projectId}"`), {
        statusCode: 400,
      });
    }
  }

  async function checkLock(
    agentId: string | undefined,
  ): Promise<string | null> {
    const lock = await ubtQ.getLock(getDb());
    if (!lock || !lock.holderAgentId) {
      return null;
    }
    if (isStale(lock.acquiredAt ? lock.acquiredAt.toISOString() : null)) {
      return null;
    }
    if (agentId && lock.holderAgentId === agentId) {
      return null;
    }
    return lock.holderAgentId;
  }

  function getStagingWorktree(
    agentName: string | undefined,
    project: ProjectConfig,
  ): string {
    const worktreeRoot =
      project.stagingWorktreeRoot ?? config.server.stagingWorktreeRoot;
    if (worktreeRoot && agentName) {
      return path.join(worktreeRoot, agentName);
    }
    return project.path;
  }

  function getBareRepoPath(project: ProjectConfig): string {
    return project.bareRepoPath;
  }

  /**
   * Reset the staging worktree to the bare repo's branch tip.
   *
   * Every call produces a coherent worktree: HEAD, index, and working tree all
   * match FETCH_HEAD. Unignored untracked files (random test output, junk) are
   * cleaned. Gitignored paths (Saved/, Intermediate/, Binaries/,
   * DerivedDataCache/, plugin copies) are preserved so the next build reuses
   * cached artifacts.
   */
  async function syncWorktree(
    agentName: string | undefined,
    projectId: string,
    project: ProjectConfig,
  ): Promise<void> {
    const worktreePath = getStagingWorktree(agentName, project);
    const bareRepo = getBareRepoPath(project);

    const dbRow = await projectsQ.getById(getDb(), projectId);
    const proj = getProject(config, projectId, dbRow ?? undefined);
    let branch = seedBranchFor(projectId, proj);
    if (agentName) {
      const agentRow = await agentsQ.getWorktreeInfo(
        getDb(),
        projectId,
        agentName,
      );
      if (agentRow?.worktree) {
        branch = agentRow.worktree;
      }
    }

    const fetchResult = await runCommand(
      "git",
      ["fetch", bareRepo, branch],
      worktreePath,
      30000,
    );
    if (!fetchResult.success) {
      throw new Error(`syncWorktree: git fetch failed: ${fetchResult.stderr}`);
    }

    const resetResult = await runCommand(
      "git",
      ["reset", "--hard", "FETCH_HEAD"],
      worktreePath,
      30000,
    );
    if (!resetResult.success) {
      throw new Error(
        `syncWorktree: git reset --hard failed: ${resetResult.stderr}`,
      );
    }

    const cleanResult = await runCommand(
      "git",
      ["clean", "-fd"],
      worktreePath,
      30000,
    );
    if (!cleanResult.success) {
      throw new Error(`syncWorktree: git clean failed: ${cleanResult.stderr}`);
    }
  }

  /**
   * Shared preamble for /build and /test: validate agent name, resolve project,
   * check UBT lock, sync worktree, ensure staging plugins.
   * Returns the resolved context or a SpawnResult error to return early.
   */
  async function prepareBuildOrTest(
    agentName: string | undefined,
    agentId: string | undefined,
    projectId: string,
  ): Promise<
    | { ok: true; project: ProjectConfig; projectId: string; cwd: string }
    | { ok: false; result: SpawnResult }
  > {
    if (agentName && !AGENT_NAME_RE.test(agentName)) {
      return {
        ok: false,
        result: {
          success: false,
          exit_code: -1,
          output: "",
          stderr: "Invalid X-Agent-Name header format",
        },
      };
    }

    const { project } = await resolveProjectForAgent(projectId);
    let resolvedAgentId = agentId;
    if (!resolvedAgentId && agentName) {
      const agentRow = await resolveAgent(getDb(), projectId, agentName);
      resolvedAgentId = agentRow?.id;
    }
    const holder = await checkLock(resolvedAgentId);
    if (holder) {
      return {
        ok: false,
        result: {
          success: false,
          exit_code: -1,
          output: "",
          stderr: `UBT lock held by '${holder}'. The build hook should have acquired the lock first — this is unexpected.`,
        },
      };
    }

    try {
      await syncWorktree(agentName, projectId, project);
    } catch (err) {
      return {
        ok: false,
        result: {
          success: false,
          exit_code: -1,
          output: "",
          stderr: `Infrastructure error: ${(err as Error).message}. Agent should shut down.`,
        },
      };
    }

    const cwd = getStagingWorktree(agentName, project);
    await ensureStagingPlugins(cwd, config);

    return { ok: true, project, projectId, cwd };
  }

  /**
   * Run a build/test with UBT-contention retry, tracking the child in the build
   * registry (so the sweeper sees a live build and never expires the lock under
   * it) and reaping the process tree if the client disconnects mid-build.
   */
  async function runTrackedBuild(
    command: string,
    scriptArgs: string[],
    cwd: string,
    timeoutMs: number,
    histId: number,
    request: FastifyRequest,
  ): Promise<SpawnResult> {
    let settled = false;
    let currentChild: ChildProcess | null = null;

    // If the container (HTTP client) disconnects before we finish — its curl
    // --max-time elapses, or the container dies — reap the build instead of
    // letting it free-run unowned on the host.
    const onClose = () => {
      if (!settled && currentChild?.pid != null) {
        killTree(currentChild.pid);
      }
    };
    request.raw.on("close", onClose);

    try {
      return await runWithUbtRetry(
        () =>
          runCommand(command, scriptArgs, cwd, timeoutMs, (child) => {
            currentChild = child;
            registerBuild(histId, child);
          }),
        config.build.ubtRetryCount,
        config.build.ubtRetryDelayMs,
      );
    } finally {
      settled = true;
      unregisterBuild(histId);
      request.raw.off("close", onClose);
    }
  }

  fastify.post<{
    Body: { clean?: boolean; operation?: string };
  }>("/build", { schema: { body: BUILD_BODY_SCHEMA } }, async (request) => {
    // NOTE: x-agent-name and x-agent-id are trusted without authentication.
    // This relies on network-isolated deployment (containers on the same host).
    // If the server is exposed to untrusted networks, agent identity must be
    // authenticated.
    const agentName = request.headers["x-agent-name"] as string | undefined;
    const agentId = request.headers["x-agent-id"] as string | undefined;
    const prep = await prepareBuildOrTest(
      agentName,
      agentId,
      request.projectId,
    );
    if (!prep.ok) return prep.result;
    const { project, projectId, cwd } = prep;

    const args = ["--summary"];
    if (request.body.clean) {
      args.push("--clean");
    }

    const scriptPath = project.build?.scriptPath ?? config.build.scriptPath;
    const { command, scriptArgs } = resolveScript(scriptPath, args);

    const buildTimeoutMs =
      project.build?.buildTimeoutMs ?? config.build.buildTimeoutMs;
    const agentForHistory = agentName ?? "unknown";
    const histId = await recordBuildStart(agentForHistory, "build", projectId);
    const t0 = Date.now();
    const result = await runTrackedBuild(
      command,
      scriptArgs,
      cwd,
      buildTimeoutMs,
      histId,
      request,
    );
    await recordBuildEnd(
      histId,
      Date.now() - t0,
      result.success,
      result.output,
      result.stderr,
    );
    return result;
  });

  fastify.post<{
    Body: TestRequestBody;
  }>("/test", { schema: { body: TEST_BODY_SCHEMA } }, async (request) => {
    const agentName = request.headers["x-agent-name"] as string | undefined;
    const agentId = request.headers["x-agent-id"] as string | undefined;
    const prep = await prepareBuildOrTest(
      agentName,
      agentId,
      request.projectId,
    );
    if (!prep.ok) return prep.result;
    const { project, projectId, cwd } = prep;

    const scriptPath =
      project.build?.testScriptPath ?? config.build.testScriptPath;
    const { command, scriptArgs } = resolveScript(
      scriptPath,
      buildTestScriptArgs(request.body, config.build.defaultTestFilters),
    );

    const testTimeoutMs =
      project.build?.testTimeoutMs ?? config.build.testTimeoutMs;
    const agentForHistory = agentName ?? "unknown";
    const histId = await recordBuildStart(agentForHistory, "test", projectId);
    const t0 = Date.now();
    const result = await runTrackedBuild(
      command,
      scriptArgs,
      cwd,
      testTimeoutMs,
      histId,
      request,
    );
    await recordBuildEnd(
      histId,
      Date.now() - t0,
      result.success,
      result.output,
      result.stderr,
    );
    return result;
  });
};

export default buildPlugin;
