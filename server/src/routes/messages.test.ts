import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestContext } from '../test-helper.js';
import messagesPlugin from './messages.js';

describe('messages routes', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
    await ctx.app.register(messagesPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.cleanup();
  });

  it('POST /messages creates a message, GET /messages/:channel returns it', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      headers: { 'x-agent-name': 'agent-1' },
      payload: { channel: 'general', type: 'info', payload: { text: 'hello' } },
    });
    assert.equal(post.statusCode, 200);
    const postBody = post.json();
    assert.equal(postBody.ok, true);
    assert.equal(typeof postBody.id, 'number');

    const get = await ctx.app.inject({
      method: 'GET',
      url: '/messages/general',
    });
    assert.equal(get.statusCode, 200);
    const messages = get.json();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].from_agent, 'agent-1');
    assert.equal(messages[0].channel, 'general');
    assert.equal(messages[0].type, 'info');
    assert.deepEqual(messages[0].payload, { text: 'hello' });
  });

  it('GET /messages/:channel with ?since= filters correctly', async () => {
    // Create two messages
    const r1 = await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      payload: { channel: 'ch', type: 'a', payload: 'first' },
    });
    const id1 = r1.json().id;

    await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      payload: { channel: 'ch', type: 'a', payload: 'second' },
    });

    const get = await ctx.app.inject({
      method: 'GET',
      url: `/messages/ch?since=${id1}`,
    });
    const messages = get.json();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].payload, 'second');
  });

  it('GET /messages/:channel with ?type= filters correctly', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      payload: { channel: 'ch', type: 'info', payload: 'one' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      payload: { channel: 'ch', type: 'error', payload: 'two' },
    });

    const get = await ctx.app.inject({
      method: 'GET',
      url: '/messages/ch?type=error',
    });
    const messages = get.json();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'error');
  });

  it('POST /messages/:id/claim succeeds first time', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      payload: { channel: 'ch', type: 'task', payload: 'do it' },
    });
    const id = post.json().id;

    const claim = await ctx.app.inject({
      method: 'POST',
      url: `/messages/${id}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });
    assert.equal(claim.statusCode, 200);
    assert.deepEqual(claim.json(), { ok: true });
  });

  it('POST /messages/:id/claim returns 409 on already-claimed', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      payload: { channel: 'ch', type: 'task', payload: 'do it' },
    });
    const id = post.json().id;

    await ctx.app.inject({
      method: 'POST',
      url: `/messages/${id}/claim`,
      headers: { 'x-agent-name': 'agent-1' },
    });

    const claim2 = await ctx.app.inject({
      method: 'POST',
      url: `/messages/${id}/claim`,
      headers: { 'x-agent-name': 'agent-2' },
    });
    assert.equal(claim2.statusCode, 409);
  });

  it('POST /messages/:id/resolve sets result and resolved_at', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      payload: { channel: 'ch', type: 'task', payload: 'do it' },
    });
    const id = post.json().id;

    const resolve = await ctx.app.inject({
      method: 'POST',
      url: `/messages/${id}/resolve`,
      payload: { result: { status: 'done', value: 42 } },
    });
    assert.equal(resolve.statusCode, 200);
    assert.deepEqual(resolve.json(), { ok: true });

    // Verify resolved data via GET
    const get = await ctx.app.inject({ method: 'GET', url: '/messages/ch' });
    const msg = get.json()[0];
    assert.ok(msg.resolved_at);
    assert.deepEqual(msg.result, { status: 'done', value: 42 });
  });
});
