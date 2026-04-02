import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import { createTestConfig } from '../test-helper.js';
import agentsPlugin from './agents.js';
import ubtPlugin, { sweepStaleLock } from './ubt.js';

describe('ubt routes (drizzle)', () => {
  let ctx: DrizzleTestContext;
  const config = createTestConfig();

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(ubtPlugin, { config });
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
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
    assert.ok(body.holderSince != null);
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

  it('sweepStaleLock does NOT clear lock held by registered agent', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/w' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-1' },
    });

    await sweepStaleLock();

    const status = await ctx.app.inject({ method: 'GET', url: '/ubt/status' });
    assert.equal(status.json().holder, 'agent-1');
  });

  it('sweepStaleLock clears lock held by deregistered agent', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/w' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-1' },
    });
    await ctx.app.inject({
      method: 'DELETE',
      url: '/agents/agent-1',
    });

    await sweepStaleLock();

    const status = await ctx.app.inject({ method: 'GET', url: '/ubt/status' });
    assert.equal(status.json().holder, null);
  });

  it('sweepStaleLock clears lock held by never-registered agent', async () => {
    // Acquire lock directly without registering the agent first
    await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'ghost-agent' },
    });

    // Verify lock is held
    const before = await ctx.app.inject({ method: 'GET', url: '/ubt/status' });
    assert.equal(before.json().holder, 'ghost-agent');

    await sweepStaleLock();

    // Lock should be released because agent was never registered
    const after = await ctx.app.inject({ method: 'GET', url: '/ubt/status' });
    assert.equal(after.json().holder, null);
  });

  it('sweepStaleLock promotes queued agent when holder was never registered', async () => {
    // Register agent-2 but NOT agent-1
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-2', worktree: '/tmp/w2' },
    });

    // agent-1 (never registered) acquires lock
    await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-1' },
    });
    // agent-2 queues
    await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-2' },
    });

    await sweepStaleLock();

    // agent-2 should be promoted
    const status = await ctx.app.inject({ method: 'GET', url: '/ubt/status' });
    assert.equal(status.json().holder, 'agent-2');
  });

  it('sweepStaleLock clears lock held by agent in stopping status', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/w' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-1' },
    });

    // Set agent to stopping status
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/agent-1/status',
      payload: { status: 'stopping' },
    });

    await sweepStaleLock();

    const status = await ctx.app.inject({ method: 'GET', url: '/ubt/status' });
    assert.equal(status.json().holder, null);
  });

  it('sweepStaleLock promotes queued agent when holder is deregistered', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/w' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-2', worktree: '/tmp/w2' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-1' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/ubt/acquire',
      payload: { agent: 'agent-2' },
    });
    await ctx.app.inject({
      method: 'DELETE',
      url: '/agents/agent-1',
    });

    await sweepStaleLock();

    const status = await ctx.app.inject({ method: 'GET', url: '/ubt/status' });
    assert.equal(status.json().holder, 'agent-2');
  });
});
