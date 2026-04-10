/**
 * Config resolver: transforms the raw ScaffoldConfig + ProjectConfig
 * into a flat, shell-script-friendly shape with sensible defaults.
 */

import { getProject, type ScaffoldConfig } from "./config.js";
import { seedBranchFor } from "./branch-naming.js";

export interface ResolvedProjectConfig {
  projectId: string;
  name: string;
  path: string;
  bareRepoPath: string;
  seedBranch: string | null;
  serverPort: number;
  enginePath: string | null;
  engineVersion: string | null;
  buildScriptPath: string | null;
  testScriptPath: string | null;
  buildTimeoutMs: number;
  testTimeoutMs: number;
  defaultTestFilters: string[];
  stagingWorktreeRoot: string | null;
  logsPath: string | null;
  agentType: string | null;
  hooks: {
    buildIntercept: string | null;
    cppLint: string | null;
    jsLint: string | null;
  };
}

/**
 * Resolve a project's full config into a flat shape suitable for
 * consumption by shell scripts via `GET /config/:projectId`.
 *
 * Throws if the projectId is not found in config.resolvedProjects.
 */
export function resolveProjectConfig(
  projectId: string,
  config: ScaffoldConfig,
): ResolvedProjectConfig {
  // getProject() throws if the projectId is unknown
  const merged = getProject(config, projectId);

  // Compute the seed branch: use the project-level value or fall back to convention
  const seedBranch = seedBranchFor(projectId, merged);

  return {
    projectId,
    name: merged.name,
    path: merged.path,
    bareRepoPath: merged.bareRepoPath,
    seedBranch,
    serverPort: config.server.port,
    enginePath: merged.engine?.path ?? null,
    engineVersion: merged.engine?.version ?? null,
    buildScriptPath: merged.build?.scriptPath ?? null,
    testScriptPath: merged.build?.testScriptPath ?? null,
    buildTimeoutMs: merged.build?.buildTimeoutMs ?? 660_000,
    testTimeoutMs: merged.build?.testTimeoutMs ?? 700_000,
    // defaultTestFilters is taken from the global config only because
    // ProjectConfig does not have a per-project defaultTestFilters field.
    defaultTestFilters: config.build.defaultTestFilters,
    stagingWorktreeRoot: merged.stagingWorktreeRoot ?? null,
    logsPath: null, // No logsPath in current config schema; placeholder for future
    agentType: null, // No agentType in current config schema; placeholder for future
    hooks: {
      buildIntercept: null, // No hooks in current config schema; placeholder for future
      cppLint: null,
      jsLint: null,
    },
  };
}
