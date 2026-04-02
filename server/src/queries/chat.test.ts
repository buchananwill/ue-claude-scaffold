import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import { rooms, roomMembers } from '../schema/tables.js';
import * as chatQ from './chat.js';

describe('chat queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;

    // Create a room with members
    await db.insert(rooms).values({
      id: 'chat-room',
      name: 'Chat Room',
      type: 'group',
      createdBy: 'user',
      projectId: 'default',
    });
    await db.insert(roomMembers).values([
      { roomId: 'chat-room', member: 'alice' },
      { roomId: 'chat-room', member: 'bob' },
    ]);
  });

  after(async () => {
    await tdb.close();
  });

  it('should check membership', async () => {
    assert.equal(await chatQ.isMember(db, 'chat-room', 'alice'), true);
    assert.equal(await chatQ.isMember(db, 'chat-room', 'charlie'), false);
  });

  it('should send a message and return the inserted row', async () => {
    const msg = await chatQ.sendMessage(db, {
      roomId: 'chat-room',
      sender: 'alice',
      content: 'Hello!',
    });
    assert.ok(msg.id);
    assert.equal(msg.roomId, 'chat-room');
    assert.equal(msg.sender, 'alice');
    assert.equal(msg.content, 'Hello!');
    assert.equal(msg.replyTo, null);
  });

  it('should send a reply', async () => {
    const first = await chatQ.sendMessage(db, {
      roomId: 'chat-room',
      sender: 'alice',
      content: 'First',
    });
    const reply = await chatQ.sendMessage(db, {
      roomId: 'chat-room',
      sender: 'bob',
      content: 'Reply to first',
      replyTo: first.id,
    });
    assert.equal(reply.replyTo, first.id);
  });

  it('should get latest history (default)', async () => {
    // Send several messages
    for (let i = 0; i < 5; i++) {
      await chatQ.sendMessage(db, {
        roomId: 'chat-room',
        sender: 'alice',
        content: `msg-${i}`,
      });
    }
    const history = await chatQ.getHistory(db, 'chat-room', { limit: 3 });
    assert.equal(history.length, 3);
    // Should be in ascending order (latest reversed)
    assert.ok(history[0].id < history[1].id);
    assert.ok(history[1].id < history[2].id);
  });

  it('should paginate with before cursor', async () => {
    const all = await chatQ.getHistory(db, 'chat-room', { limit: 500 });
    const midId = all[Math.floor(all.length / 2)].id;

    const page = await chatQ.getHistory(db, 'chat-room', { before: midId, limit: 100 });
    assert.ok(page.length > 0);
    assert.ok(page.every((m) => m.id < midId));
    // Should be ascending order
    for (let i = 1; i < page.length; i++) {
      assert.ok(page[i].id > page[i - 1].id);
    }
  });

  it('should paginate with after cursor', async () => {
    const all = await chatQ.getHistory(db, 'chat-room', { limit: 500 });
    const firstId = all[0].id;

    const page = await chatQ.getHistory(db, 'chat-room', { after: firstId, limit: 3 });
    assert.ok(page.length > 0);
    assert.ok(page.every((m) => m.id > firstId));
    // Should be ascending order
    for (let i = 1; i < page.length; i++) {
      assert.ok(page[i].id > page[i - 1].id);
    }
  });
});
