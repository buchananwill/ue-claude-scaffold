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
  };
  server: {
    port: number;
    ubtLockTimeoutMs: number;
    stagingWorktreePath?: string;
    bareRepoPath?: string;
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
    },
    server: {
      port: Number(process.env['SERVER_PORT'] ?? raw.server?.port ?? 9100),
      ubtLockTimeoutMs: raw.server?.ubtLockTimeoutMs ?? 600000,
      stagingWorktreePath: raw.server?.stagingWorktreePath,
      bareRepoPath: raw.server?.bareRepoPath,
    },
  };

  return config;
}
