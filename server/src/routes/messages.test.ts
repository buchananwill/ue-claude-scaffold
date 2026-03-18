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
    assert.equal(messages[0].fromAgent, 'agent-1');
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

  // === DELETE /messages/:id (single message) ===

  it('DELETE /messages/:id deletes a single message', async () => {
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      headers: { 'x-agent-name': 'agent-1' },
      payload: { channel: 'general', type: 'info', payload: 'to-delete' },
    });
    const id = post.json().id;

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/messages/${id}`,
    });
    assert.equal(del.statusCode, 200);
    assert.deepEqual(del.json(), { ok: true });

    // Verify it's gone
    const get = await ctx.app.inject({ method: 'GET', url: '/messages/general' });
    assert.equal(get.json().length, 0);
  });

  it('DELETE /messages/:id returns 404 for non-existent ID', async () => {
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/messages/99999',
    });
    assert.equal(del.statusCode, 404);
  });

  // === DELETE /messages/:channel (channel purge) ===

  it('DELETE /messages/:channel purges all messages in a channel', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      payload: { channel: 'logs', type: 'info', payload: 'msg1' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      payload: { channel: 'logs', type: 'info', payload: 'msg2' },
    });

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/messages/logs',
    });
    assert.equal(del.statusCode, 200);
    const body = del.json();
    assert.equal(body.ok, true);
    assert.equal(body.deleted, 2);

    // Verify empty
    const get = await ctx.app.inject({ method: 'GET', url: '/messages/logs' });
    assert.equal(get.json().length, 0);
  });

  it('DELETE /messages/:channel?before=<id> deletes only older messages', async () => {
    const r1 = await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      payload: { channel: 'logs', type: 'info', payload: 'first' },
    });
    const id1 = r1.json().id;

    const r2 = await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      payload: { channel: 'logs', type: 'info', payload: 'second' },
    });
    const id2 = r2.json().id;

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/messages/logs?before=${id2}`,
    });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().deleted, 1);

    // Verify only id2 remains
    const get = await ctx.app.inject({ method: 'GET', url: '/messages/logs' });
    const messages = get.json();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, id2);
  });

  it('DELETE /messages/:channel?before= returns deleted:0 when nothing qualifies', async () => {
    const r1 = await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      payload: { channel: 'logs', type: 'info', payload: 'only' },
    });
    const id1 = r1.json().id;

    // before=id1 means id < id1, so nothing matches
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/messages/logs?before=${id1}`,
    });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().deleted, 0);
  });

  it('DELETE /messages/:channel returns deleted:0 for empty/nonexistent channel', async () => {
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/messages/nonexistent',
    });
    assert.equal(del.statusCode, 200);
    assert.deepEqual(del.json(), { ok: true, deleted: 0 });
  });

  it('DELETE /messages/:channel does not affect other channels', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      payload: { channel: 'a', type: 'info', payload: 'in-a' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      payload: { channel: 'b', type: 'info', payload: 'in-b' },
    });

    await ctx.app.inject({
      method: 'DELETE',
      url: '/messages/a',
    });

    // Channel b should still have its message
    const get = await ctx.app.inject({ method: 'GET', url: '/messages/b' });
    const messages = get.json();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].payload, 'in-b');
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
    assert.ok(msg.resolvedAt);
    assert.deepEqual(msg.result, { status: 'done', value: 42 });
  });
});
