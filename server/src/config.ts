import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

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
  };
  server: {
    port: number;
    ubtLockTimeoutMs: number;
    stagingWorktreeRoot?: string;
    bareRepoRoot?: string;
    stagingWorktreePath?: string;
    bareRepoPath?: string;
  };
  tasks?: {
    path: string;
  };
  claudeMdPatches?: {
    pathRemaps: Record<string, string>;
    agentSubstitutions: Record<string, string>;
  };
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

  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));

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
      buildTimeoutMs: raw.build?.buildTimeoutMs ?? 660_000,
      testTimeoutMs: raw.build?.testTimeoutMs ?? 700_000,
    },
    server: {
      port: raw.server?.port ?? 9100,
      ubtLockTimeoutMs: raw.server?.ubtLockTimeoutMs ?? 600000,
      stagingWorktreeRoot: raw.server?.stagingWorktreeRoot,
      bareRepoRoot: raw.server?.bareRepoRoot,
      stagingWorktreePath: raw.server?.stagingWorktreePath,
      bareRepoPath: raw.server?.bareRepoPath,
    },
    tasks: {
      path: raw.tasks?.path ?? '',
    },
  };

  // Validate required fields
  const missing: string[] = [];
  if (!config.project.path) missing.push('project.path');
  if (!config.engine.path) missing.push('engine.path');
  if (!config.build.scriptPath) missing.push('build.scriptPath');
  if (!config.build.testScriptPath) missing.push('build.testScriptPath');
  if (!config.server.stagingWorktreePath && !config.server.stagingWorktreeRoot && !config.project.path) {
    missing.push('server.stagingWorktreeRoot or server.stagingWorktreePath (or project.path as fallback)');
  }
  if (!config.server.bareRepoPath && !config.server.bareRepoRoot) {
    missing.push('server.bareRepoRoot or server.bareRepoPath');
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

  return config;
}
