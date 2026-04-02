import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestConfig } from '../test-helper.js';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import healthPlugin from './health.js';

describe('GET /health', () => {
  const config = createTestConfig({ server: { port: 9200, ubtLockTimeoutMs: 300000, bareRepoPath: '/tmp/repo.git' } });
  let ctx: DrizzleTestContext;

  it('returns 200 with status, db, and config summary', async () => {
    ctx = await createDrizzleTestApp();

    await ctx.app.register(healthPlugin, { config, pgliteDataDir: './data/pglite' });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/health',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.db, 'PGlite (./data/pglite)');
    assert.equal(body.config.port, 9200);
    assert.equal(body.config.projectName, 'TestProject');
    assert.equal(body.config.ubtLockTimeoutMs, 300000);

    await ctx.app.close();
  });

  after(async () => {
    await ctx?.cleanup();
  });
});
