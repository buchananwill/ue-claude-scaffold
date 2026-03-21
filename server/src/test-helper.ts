import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { openDb } from './db.js';
import type { ScaffoldConfig } from './config.js';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

export function createTestConfig(overrides?: Partial<ScaffoldConfig>): ScaffoldConfig {
  return {
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
    ...overrides,
  };
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
