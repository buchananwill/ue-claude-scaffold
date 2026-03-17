import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, createTestConfig } from '../test-helper.js';
import healthPlugin from './health.js';

describe('GET /health', () => {
  const config = createTestConfig({ server: { port: 9200, ubtLockTimeoutMs: 300000 } });
  let cleanup: () => void;

  it('returns 200 with status, dbPath, and config summary', async () => {
    const ctx = await createTestApp();
    cleanup = ctx.cleanup;

    await ctx.app.register(healthPlugin, { dbPath: ctx.dbPath, config });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/health',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.dbPath, ctx.dbPath);
    assert.equal(body.config.port, 9200);
    assert.equal(body.config.projectName, 'TestProject');
    assert.equal(body.config.ubtLockTimeoutMs, 300000);

    await ctx.app.close();
  });

  after(() => {
    cleanup?.();
  });
});
