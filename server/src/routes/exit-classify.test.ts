import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import exitClassifyPlugin from './exit-classify.js';

describe('POST /agents/:name/exit:classify', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(exitClassifyPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it('returns abnormal=true for auth failure log', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/test-agent/exit:classify',
      payload: {
        logTail: 'Failed to authenticate. API Error: 401',
        elapsedSeconds: 30,
        outputLineCount: 10,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.abnormal, true);
    assert.match(body.reason, /authentication failure/);
  });

  it('returns abnormal=true for token exhaustion', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/test-agent/exit:classify',
      payload: {
        logTail: 'token limit exceeded for this session',
        elapsedSeconds: 120,
        outputLineCount: 200,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.abnormal, true);
    assert.match(body.reason, /token or rate limit/);
  });

  it('returns abnormal=true for rapid exit', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/test-agent/exit:classify',
      payload: {
        logTail: 'exited',
        elapsedSeconds: 2,
        outputLineCount: 1,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.abnormal, true);
    assert.match(body.reason, /rapid exit/);
  });

  it('returns abnormal=false for clean exit', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/test-agent/exit:classify',
      payload: {
        logTail: 'All tasks completed successfully.',
        elapsedSeconds: 600,
        outputLineCount: 500,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.abnormal, false);
    assert.equal(body.reason, null);
  });

  it('returns 400 for missing required fields', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/test-agent/exit:classify',
      payload: { logTail: 'some log' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 for negative elapsedSeconds', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/agents/test-agent/exit:classify',
      payload: {
        logTail: 'test',
        elapsedSeconds: -1,
        outputLineCount: 5,
      },
    });
    assert.equal(res.statusCode, 400);
  });
});
