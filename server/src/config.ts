import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface ProjectConfig {
  name: string;
  path: string;
  uprojectFile?: string;
  bareRepoPath: string;
  planBranch?: string;
  engine?: { path: string; version: string };
  build?: { scriptPath?: string; testScriptPath?: string; buildTimeoutMs?: number; testTimeoutMs?: number };
  plugins?: { stagingCopies?: Array<{ source: string; relativeDest: string }> };
  stagingWorktreeRoot?: string;
}

export interface ScaffoldConfig {
  project: {
    name: string;
    path: string;
    uprojectFile: string;
  };
  engine: {
    path: string;
    version: string;
  };
  build: {
    scriptPath: string;
    testScriptPath: string;
    defaultTestFilters: string[];
    buildTimeoutMs: number;
    testTimeoutMs: number;
    ubtRetryCount: number;
    ubtRetryDelayMs: number;
  };
  server: {
    port: number;
    ubtLockTimeoutMs: number;
    stagingWorktreeRoot?: string;
    bareRepoPath: string;
  };
  plugins?: {
    stagingCopies?: Array<{
      source: string;
      relativeDest: string;
    }>;
  };
  tasks?: {
    planBranch?: string;
  };
  /** @deprecated No longer used — CLAUDE.md is now environment-agnostic. */
  claudeMdPatches?: {
    pathRemaps: Record<string, string>;
    agentSubstitutions: Record<string, string>;
  };
  resolvedProjects: Record<string, ProjectConfig>;
}

export function loadConfig(): ScaffoldConfig {
  const candidates = [
    path.resolve('scaffold.config.json'),
    path.resolve('..', 'scaffold.config.json'),
  ];

  let configPath: string | undefined;
  for (const c of candidates) {
    if (existsSync(c)) {
      configPath = c;
      break;
    }
  }

  if (!configPath) {
    throw new Error(
      `scaffold.config.json not found. Searched:\n  ${candidates.join('\n  ')}`
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw JSON with optional-chained access throughout
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`scaffold.config.json is not valid JSON: ${message}`);
  }

  const config: ScaffoldConfig = {
    project: {
      name: raw.project?.name ?? 'UnnamedProject',
      path: raw.project?.path ?? '',
      uprojectFile: raw.project?.uprojectFile ?? '',
    },
    engine: {
      path: raw.engine?.path ?? '',
      version: raw.engine?.version ?? '',
    },
    build: {
      scriptPath: raw.build?.scriptPath ?? '',
      testScriptPath: raw.build?.testScriptPath ?? '',
      defaultTestFilters: raw.build?.defaultTestFilters ?? [],
      buildTimeoutMs: coercePositiveNumber(raw.build?.buildTimeoutMs) ?? 660_000,
      testTimeoutMs: coercePositiveNumber(raw.build?.testTimeoutMs) ?? 700_000,
      ubtRetryCount: coercePositiveNumber(raw.build?.ubtRetryCount) ?? 5,
      ubtRetryDelayMs: coercePositiveNumber(raw.build?.ubtRetryDelayMs) ?? 30_000,
    },
    server: {
      port: raw.server?.port ?? 9100,
      ubtLockTimeoutMs: coercePositiveNumber(raw.server?.ubtLockTimeoutMs) ?? 600_000,
      stagingWorktreeRoot: raw.server?.stagingWorktreeRoot,
      bareRepoPath: raw.server?.bareRepoPath ?? '',
    },
    plugins: {
      stagingCopies: Array.isArray(raw.plugins?.stagingCopies)
        ? raw.plugins.stagingCopies.map((e: Record<string, unknown>) => ({
            source: String(e.source ?? ''),
            relativeDest: String(e.relativeDest ?? ''),
          }))
        : [],
    },
    tasks: {
      planBranch: raw.tasks?.planBranch,
    },
    resolvedProjects: {},
  };

  // Build resolvedProjects from explicit projects block or synthesise from legacy fields.
  // When an explicit `projects` block is present, legacy top-level fields (project, engine, build)
  // are ignored — only the projects block is used to populate resolvedProjects.
  if (raw.projects && typeof raw.projects === 'object') {
    const projectIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;
    for (const [id, p] of Object.entries(raw.projects as Record<string, Record<string, unknown>>)) {
      if (!projectIdPattern.test(id)) {
        throw new Error(
          `Invalid project ID "${id}": must be 1-64 characters matching [a-zA-Z0-9_-].`
        );
      }
      config.resolvedProjects[id] = parseProjectConfig(id, p);
    }
  } else {
    // Synthesise default project from legacy top-level fields
    config.resolvedProjects['default'] = {
      name: config.project.name,
      path: config.project.path,
      uprojectFile: config.project.uprojectFile || undefined,
      bareRepoPath: config.server.bareRepoPath,
      planBranch: config.tasks?.planBranch,
      engine: config.engine.path ? { path: config.engine.path, version: config.engine.version } : undefined,
      build: config.build.scriptPath ? {
        scriptPath: config.build.scriptPath,
        testScriptPath: config.build.testScriptPath || undefined,
        buildTimeoutMs: config.build.buildTimeoutMs,
        testTimeoutMs: config.build.testTimeoutMs,
      } : undefined,
      plugins: config.plugins,
      stagingWorktreeRoot: config.server.stagingWorktreeRoot,
    };
  }

  validateConfig(config, !!raw.projects);

  return config;
}

export function validateConfig(config: ScaffoldConfig, hasExplicitProjects: boolean): void {
  const missing: string[] = [];

  if (hasExplicitProjects) {
    for (const [id, proj] of Object.entries(config.resolvedProjects)) {
      if (!proj.bareRepoPath) missing.push(`projects.${id}.bareRepoPath`);
      if (!proj.path) missing.push(`projects.${id}.path`);
      if (proj.engine) {
        if (!proj.engine.path) missing.push(`projects.${id}.engine.path`);
        if (!proj.engine.version) missing.push(`projects.${id}.engine.version`);
      }
      if (proj.build?.scriptPath && !proj.build.testScriptPath) {
        missing.push(`projects.${id}.build.testScriptPath`);
      }
      if (proj.build?.testScriptPath && !proj.build.scriptPath) {
        missing.push(`projects.${id}.build.scriptPath`);
      }
    }
  } else {
    if (!config.project.path) missing.push('project.path');
    if (config.engine.path !== '' || config.build.scriptPath !== '' || config.build.testScriptPath !== '') {
      // Legacy config with engine/build declared — require them fully
      if (!config.engine.path) missing.push('engine.path');
      if (!config.build.scriptPath) missing.push('build.scriptPath');
      if (!config.build.testScriptPath) missing.push('build.testScriptPath');
    }
    if (!config.server.stagingWorktreeRoot && !config.project.path) {
      missing.push('server.stagingWorktreeRoot (or project.path as fallback)');
    }
  }

  if (!config.server.bareRepoPath && !hasExplicitProjects) {
    missing.push('server.bareRepoPath');
  }

  if (missing.length > 0) {
    throw new Error(
      `scaffold.config.json is missing required fields:\n` +
      missing.map((f) => `  - ${f}`).join('\n') +
      `\n\nCopy scaffold.config.example.json and fill in the paths for your project.`
    );
  }

  const port = config.server.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`server.port must be 1–65535 (got ${port})`);
  }
}

function coercePositiveNumber(value: unknown): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseProjectConfig(id: string, p: Record<string, unknown>): ProjectConfig {
  const build = p.build as Record<string, unknown> | undefined;
  const engine = p.engine as Record<string, unknown> | undefined;
  const plugins = p.plugins as Record<string, unknown> | undefined;
  return {
    name: String(p.name ?? id),
    path: String(p.path ?? ''),
    uprojectFile: p.uprojectFile != null ? String(p.uprojectFile) : undefined,
    bareRepoPath: String(p.bareRepoPath ?? ''),
    planBranch: p.planBranch != null ? String(p.planBranch) : undefined,
    engine: engine ? { path: String(engine.path ?? ''), version: String(engine.version ?? '') } : undefined,
    build: build ? {
      scriptPath: build.scriptPath != null ? String(build.scriptPath) : undefined,
      testScriptPath: build.testScriptPath != null ? String(build.testScriptPath) : undefined,
      buildTimeoutMs: coercePositiveNumber(build.buildTimeoutMs),
      testTimeoutMs: coercePositiveNumber(build.testTimeoutMs),
    } : undefined,
    plugins: plugins ? {
      stagingCopies: Array.isArray(plugins.stagingCopies)
        ? (plugins.stagingCopies as Record<string, unknown>[]).map((e) => ({
            source: String(e.source ?? ''),
            relativeDest: String(e.relativeDest ?? ''),
          }))
        : undefined,
    } : undefined,
    stagingWorktreeRoot: p.stagingWorktreeRoot != null ? String(p.stagingWorktreeRoot) : undefined,
  };
}

export function getProject(config: ScaffoldConfig, id: string): ProjectConfig {
  const project = config.resolvedProjects[id];
  if (!project) {
    throw new Error(`Unknown project: "${id.slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, '?')}"`);
  }
  return project;
}
