import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, createTestConfig, type TestContext } from '../test-helper.js';
import ubtPlugin from './ubt.js';

describe('ubt routes', () => {
  let ctx: TestContext;
  const config = createTestConfig();

  beforeEach(async () => {
    ctx = await createTestApp();
    await ctx.app.register(ubtPlugin, { config });
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.cleanup();
  });

  it('GET /ubt/status returns empty state initially', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/ubt/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.holder, null);
    assert.equal(body.acquiredAt, null);
    assert.deepEqual(body.queue, []);
  });

  it('POST /ubt/acquire when free grants the lock', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { granted: true });
  });

  it('POST /ubt/acquire when held by same agent returns granted true', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-1' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().granted, true);
  });

  it('POST /ubt/acquire when held by other returns granted false with position and backoff', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-1' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-2' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.granted, false);
    assert.equal(typeof body.position, 'number');
    assert.equal(typeof body.backoffMs, 'number');
    assert.ok(body.position >= 1);
  });

  it('POST /ubt/acquire duplicate queue entry returns existing position', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-1' },
    });

    // First enqueue
    const r1 = await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-2' },
    });
    const pos1 = r1.json().position;

    // Second attempt - should return existing position, not re-enqueue
    const r2 = await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-2' },
    });
    const body2 = r2.json();
    assert.equal(body2.granted, false);
    assert.equal(body2.position, pos1);
  });

  it('POST /ubt/release clears lock', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-1' },
    });

    const rel = await ctx.app.inject({
      method: 'POST',
      url: '/ubt/release',
      payload: { agent: 'agent-1' },
    });
    assert.equal(rel.statusCode, 200);
    assert.equal(rel.json().ok, true);

    // Verify lock is cleared
    const status = await ctx.app.inject({ method: 'GET', url: '/ubt/status' });
    assert.equal(status.json().holder, null);
  });

  it('POST /ubt/release promotes next from queue', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-1' },
    });
    // agent-2 enqueues
    await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-2' },
    });

    const rel = await ctx.app.inject({
      method: 'POST',
      url: '/ubt/release',
      payload: { agent: 'agent-1' },
    });
    assert.equal(rel.json().ok, true);
    assert.equal(rel.json().promoted, 'agent-2');

    // Verify agent-2 now holds the lock
    const status = await ctx.app.inject({ method: 'GET', url: '/ubt/status' });
    assert.equal(status.json().holder, 'agent-2');
  });

  it('POST /ubt/acquire when held by other includes holder, holderSince, and estimatedWaitMs', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-1' },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-2' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.granted, false);
    assert.equal(body.holder, 'agent-1');
    assert.equal(typeof body.holderSince, 'string');
    assert.equal(typeof body.estimatedWaitMs, 'number');
    assert.ok(body.estimatedWaitMs > 0);
  });

  it('GET /ubt/status includes estimatedWaitMs', async () => {
    // When no holder, estimatedWaitMs should be 0
    const emptyRes = await ctx.app.inject({ method: 'GET', url: '/ubt/status' });
    assert.equal(emptyRes.json().estimatedWaitMs, 0);

    // When a holder exists, estimatedWaitMs should be > 0
    await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-1' },
    });
    const heldRes = await ctx.app.inject({ method: 'GET', url: '/ubt/status' });
    const heldBody = heldRes.json();
    assert.equal(typeof heldBody.estimatedWaitMs, 'number');
    assert.ok(heldBody.estimatedWaitMs > 0);
  });

  it('POST /ubt/release when no lock held returns not_held', async () => {
    const rel = await ctx.app.inject({
      method: 'POST',
      url: '/ubt/release',
      payload: { agent: 'agent-1' },
    });
    assert.equal(rel.statusCode, 200);
    assert.equal(rel.json().ok, false);
    assert.equal(rel.json().reason, 'not_held');
  });
});
