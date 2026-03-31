import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { ScaffoldConfig } from './config.js';
import { openDb } from './db.js';

export function createTestConfig(overrides?: Partial<ScaffoldConfig>): ScaffoldConfig {
  const base: ScaffoldConfig = {
    project: {
      name: 'TestProject',
      path: '/tmp/test-project',
      uprojectFile: '/tmp/test-project/Test.uproject',
    },
    engine: {
      path: '/tmp/engine',
      version: '5.4',
    },
    build: {
      scriptPath: '/tmp/build.sh',
      testScriptPath: '/tmp/test.sh',
      defaultTestFilters: [],
      buildTimeoutMs: 660_000,
      testTimeoutMs: 700_000,
      ubtRetryCount: 5,
      ubtRetryDelayMs: 30_000,
    },
    server: {
      port: 9100,
      ubtLockTimeoutMs: 600000,
      bareRepoPath: '/tmp/test-repo.git',
    },
    resolvedProjects: {
      default: {
        name: 'TestProject',
        path: '/tmp/test-project',
        uprojectFile: '/tmp/test-project/Test.uproject',
        bareRepoPath: '/tmp/test-repo.git',
        engine: { path: '/tmp/engine', version: '5.4' },
        build: { scriptPath: '/tmp/build.sh', testScriptPath: '/tmp/test.sh', buildTimeoutMs: 660_000, testTimeoutMs: 700_000 },
      },
    },
    ...overrides,
  };

  // Ensure resolvedProjects['default'] reflects any top-level overrides
  // so that getProject(config, 'default') returns consistent values.
  if (!overrides?.resolvedProjects && base.resolvedProjects['default']) {
    const rp = base.resolvedProjects['default'];
    if (overrides?.server?.bareRepoPath) rp.bareRepoPath = overrides.server.bareRepoPath;
    if (overrides?.server?.stagingWorktreeRoot) rp.stagingWorktreeRoot = overrides.server.stagingWorktreeRoot;
    if (overrides?.project?.path) rp.path = overrides.project.path;
    if (overrides?.project?.name) rp.name = overrides.project.name;
    if (overrides?.tasks?.planBranch) rp.planBranch = overrides.tasks.planBranch;
    if (overrides?.build?.scriptPath) {
      rp.build = rp.build ?? {};
      rp.build.scriptPath = overrides.build.scriptPath;
    }
    if (overrides?.build?.testScriptPath) {
      rp.build = rp.build ?? {};
      rp.build.testScriptPath = overrides.build.testScriptPath;
    }
  }

  return base;
}

export interface TestContext {
  app: FastifyInstance;
  dbPath: string;
  tmpDir: string;
  cleanup: () => void;
}

export async function createTestApp(): Promise<TestContext> {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'scaffold-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  openDb(dbPath);

  const app = Fastify({ logger: false });
  await app.register(sensible);

  const cleanup = () => {
    try { unlinkSync(dbPath); } catch {}
    try { unlinkSync(dbPath + '-wal'); } catch {}
    try { unlinkSync(dbPath + '-shm'); } catch {}
    try { rmdirSync(tmpDir); } catch {}
  };

  return { app, dbPath, tmpDir, cleanup };
}
