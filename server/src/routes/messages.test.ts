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

  // === Count endpoint tests ===

  it('GET /messages/:channel/count returns total message count', async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.app.inject({
        method: 'POST',
        url: '/messages',
        payload: { channel: 'test-channel', type: 'info', payload: `msg${i}` },
      });
    }

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/messages/test-channel/count',
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { count: 5 });
  });

  it('GET /messages/:channel/count?type= filters by type', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      payload: { channel: 'tc', type: 'info', payload: 'a' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      payload: { channel: 'tc', type: 'error', payload: 'b' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/messages',
      payload: { channel: 'tc', type: 'error', payload: 'c' },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/messages/tc/count?type=error',
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { count: 2 });
  });

  // === Pagination tests ===

  it('default (no params) returns most recent messages ascending', async () => {
    // Insert 5 messages
    for (let i = 1; i <= 5; i++) {
      await ctx.app.inject({
        method: 'POST',
        url: '/messages',
        payload: { channel: 'pg', type: 'info', payload: `msg${i}` },
      });
    }

    const get = await ctx.app.inject({
      method: 'GET',
      url: '/messages/pg?limit=3',
    });
    const msgs = get.json();
    assert.equal(msgs.length, 3);
    // Should be most recent 3, in ascending order
    assert.equal(msgs[0].payload, 'msg3');
    assert.equal(msgs[1].payload, 'msg4');
    assert.equal(msgs[2].payload, 'msg5');
    // Ascending order
    assert.ok(msgs[0].id < msgs[1].id);
    assert.ok(msgs[1].id < msgs[2].id);
  });

  it('?before=<id> returns older messages ascending', async () => {
    const ids: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const r = await ctx.app.inject({
        method: 'POST',
        url: '/messages',
        payload: { channel: 'pg', type: 'info', payload: `msg${i}` },
      });
      ids.push(r.json().id);
    }

    const get = await ctx.app.inject({
      method: 'GET',
      url: `/messages/pg?before=${ids[3]}&limit=2`,
    });
    const msgs = get.json();
    assert.equal(msgs.length, 2);
    // Should be the 2 most recent before ids[3], ascending
    assert.equal(msgs[0].payload, 'msg2');
    assert.equal(msgs[1].payload, 'msg3');
    assert.ok(msgs[0].id < msgs[1].id);
  });

  it('?before=<id> returns fewer than limit when exhausted', async () => {
    const ids: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const r = await ctx.app.inject({
        method: 'POST',
        url: '/messages',
        payload: { channel: 'pg', type: 'info', payload: `msg${i}` },
      });
      ids.push(r.json().id);
    }

    const get = await ctx.app.inject({
      method: 'GET',
      url: `/messages/pg?before=${ids[1]}&limit=10`,
    });
    const msgs = get.json();
    // Only 1 message exists before ids[1]
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].payload, 'msg1');
  });

  it('?limit=N caps response', async () => {
    for (let i = 1; i <= 10; i++) {
      await ctx.app.inject({
        method: 'POST',
        url: '/messages',
        payload: { channel: 'pg', type: 'info', payload: `msg${i}` },
      });
    }

    const get = await ctx.app.inject({
      method: 'GET',
      url: '/messages/pg?limit=4',
    });
    const msgs = get.json();
    assert.equal(msgs.length, 4);
  });

  it('?since=<id> returns all messages after cursor without limit', async () => {
    const ids: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const r = await ctx.app.inject({
        method: 'POST',
        url: '/messages',
        payload: { channel: 'pg', type: 'info', payload: `msg${i}` },
      });
      ids.push(r.json().id);
    }

    // Even with limit=2, since should return all after cursor
    const get = await ctx.app.inject({
      method: 'GET',
      url: `/messages/pg?since=${ids[0]}&limit=2`,
    });
    const msgs = get.json();
    // since ignores limit, returns all 9 remaining
    assert.equal(msgs.length, 9);
    assert.equal(msgs[0].payload, 'msg2');
    assert.equal(msgs[8].payload, 'msg10');
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
