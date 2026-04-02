import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import * as msgQ from './messages.js';

describe('messages queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;
  });

  after(async () => {
    await tdb.close();
  });

  it('should insert a message and return id', async () => {
    const id = await msgQ.insert(db, {
      fromAgent: 'agent-1',
      channel: 'progress',
      type: 'status',
      payload: { text: 'hello' },
    });
    assert.equal(typeof id, 'number');
    assert.ok(id > 0);
  });

  it('should list messages with no filters (paging mode)', async () => {
    // Insert a few more
    await msgQ.insert(db, { fromAgent: 'agent-1', channel: 'progress', type: 'log', payload: 'msg2' });
    await msgQ.insert(db, { fromAgent: 'agent-2', channel: 'errors', type: 'error', payload: 'msg3' });

    const all = await msgQ.list(db);
    assert.ok(all.length >= 3);
    // Should be in ascending id order (reversed from DESC)
    for (let i = 1; i < all.length; i++) {
      assert.ok(all[i].id > all[i - 1].id);
    }
  });

  it('should list messages filtered by channel', async () => {
    const rows = await msgQ.list(db, { channel: 'errors' });
    assert.ok(rows.every((r) => r.channel === 'errors'));
    assert.ok(rows.length >= 1);
  });

  it('should list messages in polling mode (since)', async () => {
    const rows = await msgQ.list(db, { since: 1 });
    assert.ok(rows.length >= 2);
    // ASC order
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i].id > rows[i - 1].id);
    }
    assert.ok(rows.every((r) => r.id > 1));
  });

  it('should list with before (paging)', async () => {
    const all = await msgQ.list(db);
    const lastId = all[all.length - 1].id;
    const rows = await msgQ.list(db, { before: lastId });
    assert.ok(rows.every((r) => r.id < lastId));
  });

  it('should list filtered by type and fromAgent', async () => {
    const rows = await msgQ.list(db, { type: 'status', fromAgent: 'agent-1' });
    assert.ok(rows.every((r) => r.type === 'status' && r.fromAgent === 'agent-1'));
  });

  it('should count messages', async () => {
    const total = await msgQ.count(db);
    assert.ok(total >= 3);
  });

  it('should count with channel filter', async () => {
    const c = await msgQ.count(db, { channel: 'errors' });
    assert.ok(c >= 1);
  });

  it('should claim a message', async () => {
    const id = await msgQ.insert(db, {
      fromAgent: 'agent-1',
      channel: 'requests',
      type: 'request',
      payload: { action: 'review' },
    });
    const ok = await msgQ.claim(db, id, 'agent-2');
    assert.equal(ok, true);
  });

  it('should fail to claim already-claimed message', async () => {
    const id = await msgQ.insert(db, {
      fromAgent: 'agent-1',
      channel: 'requests',
      type: 'request',
      payload: { action: 'build' },
    });
    await msgQ.claim(db, id, 'agent-2');
    const ok = await msgQ.claim(db, id, 'agent-3');
    assert.equal(ok, false);
  });

  it('should resolve a message', async () => {
    const id = await msgQ.insert(db, {
      fromAgent: 'agent-1',
      channel: 'requests',
      type: 'request',
      payload: 'test',
    });
    await msgQ.resolve(db, id, { status: 'done' });
    const rows = await msgQ.list(db, { channel: 'requests', since: id - 1 });
    const msg = rows.find((r) => r.id === id);
    assert.ok(msg);
    assert.ok(msg.resolvedAt);
  });

  it('should delete by id', async () => {
    const id = await msgQ.insert(db, {
      fromAgent: 'x',
      channel: 'tmp',
      type: 'tmp',
      payload: 'delete-me',
    });
    const ok = await msgQ.deleteById(db, id);
    assert.equal(ok, true);
    const notFound = await msgQ.deleteById(db, id);
    assert.equal(notFound, false);
  });

  it('should delete by channel', async () => {
    await msgQ.insert(db, { fromAgent: 'x', channel: 'bulk', type: 't', payload: 1 });
    await msgQ.insert(db, { fromAgent: 'x', channel: 'bulk', type: 't', payload: 2 });
    const count = await msgQ.deleteByChannel(db, 'bulk');
    assert.equal(count, 2);
  });

  it('should delete by channel before id', async () => {
    const id1 = await msgQ.insert(db, { fromAgent: 'x', channel: 'trim', type: 't', payload: 1 });
    const id2 = await msgQ.insert(db, { fromAgent: 'x', channel: 'trim', type: 't', payload: 2 });
    const id3 = await msgQ.insert(db, { fromAgent: 'x', channel: 'trim', type: 't', payload: 3 });
    const count = await msgQ.deleteByChannelBefore(db, 'trim', id3);
    assert.equal(count, 2);
    // id3 should still exist
    const remaining = await msgQ.list(db, { channel: 'trim' });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, id3);
  });
});
