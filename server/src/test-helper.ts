import type { FastifyInstance } from 'fastify';
import type { ScaffoldConfig } from './config.js';

// Re-export the Drizzle test helper as the canonical test app factory
export { createDrizzleTestApp, type DrizzleTestContext } from './drizzle-test-helper.js';

/**
 * Register an agent via POST /agents/register and return the agent UUID.
 * Useful in route tests that need a registered agent for claim/ownership operations.
 */
export async function registerAgent(
  app: FastifyInstance,
  name: string,
  projectId?: string,
): Promise<string> {
  const headers: Record<string, string> = {};
  if (projectId) headers['x-project-id'] = projectId;
  const res = await app.inject({
    method: 'POST',
    url: '/agents/register',
    payload: { name, worktree: `/tmp/${name}` },
    headers,
  });
  return res.json().id;
}

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
    configDir: '/tmp',
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
    if (overrides?.tasks?.seedBranch) rp.seedBranch = overrides.tasks.seedBranch;
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
