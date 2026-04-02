import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestConfig } from '../test-helper.js';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import healthPlugin from './health.js';
import projectsPlugin from './projects.js';
import * as projectsQ from '../queries/projects.js';

describe('GET /health', () => {
  const config = createTestConfig({ server: { port: 9200, ubtLockTimeoutMs: 300000, bareRepoPath: '/tmp/repo.git' } });
  let ctx: DrizzleTestContext;

  before(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(healthPlugin, { config, pgliteDataDir: './data/pglite' });
    await ctx.app.register(projectsPlugin);
  });

  after(async () => {
    await ctx?.app.close();
    await ctx?.cleanup();
  });

  it('returns 200 with status, db, and config summary', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/health',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.db.backend, 'pglite');
    assert.equal(body.config.port, 9200);
    assert.equal(body.config.ubtLockTimeoutMs, 300000);
    // projectName is not returned without x-project-id header
    assert.equal(body.config.projectName, undefined);
  });

  it('returns projectName when valid x-project-id is sent', async () => {
    // Create a project directly via query layer
    await projectsQ.create(ctx.db, { id: 'health-test', name: 'Health Test Project' });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-project-id': 'health-test' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.config.projectName, 'Health Test Project');
  });

  it('omits projectName when unknown x-project-id is sent', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-project-id': 'nonexistent-proj' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.config.projectName, undefined);
  });
});
