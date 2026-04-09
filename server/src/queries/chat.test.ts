import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import { rooms, agents } from '../schema/tables.js';
import * as chatQ from './chat.js';
import * as roomQ from './rooms.js';

describe('chat queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;
  let aliceId: string;
  let bobId: string;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;

    // Seed agents
    aliceId = uuidv7();
    bobId = uuidv7();
    await db.insert(agents).values([
      { id: aliceId, name: 'alice', worktree: '/tmp/alice', status: 'idle', projectId: 'default' },
      { id: bobId, name: 'bob', worktree: '/tmp/bob', status: 'idle', projectId: 'default' },
    ]);

    // Create a room with members
    await roomQ.createRoom(db, {
      id: 'chat-room',
      name: 'Chat Room',
      type: 'group',
      createdBy: 'user',
      projectId: 'default',
    });
    await roomQ.addMember(db, 'chat-room', aliceId);
    await roomQ.addMember(db, 'chat-room', bobId);
  });

  after(async () => {
    await tdb.close();
  });

  it('should check membership via isAgentMember', async () => {
    assert.equal(await chatQ.isAgentMember(db, 'chat-room', aliceId), true);
    // Random UUID that is not a member
    assert.equal(await chatQ.isAgentMember(db, 'chat-room', uuidv7()), false);
  });

  it('should send an agent-authored message and return the inserted row', async () => {
    const msg = await chatQ.sendMessage(db, {
      roomId: 'chat-room',
      authorType: 'agent',
      authorAgentId: aliceId,
      content: 'Hello!',
    });
    assert.ok(msg.id);
    assert.equal(msg.roomId, 'chat-room');
    assert.equal(msg.authorType, 'agent');
    assert.equal(msg.authorAgentId, aliceId);
    assert.equal(msg.content, 'Hello!');
    assert.equal(msg.replyTo, null);
  });

  it('should send an operator-authored message', async () => {
    const msg = await chatQ.sendMessage(db, {
      roomId: 'chat-room',
      authorType: 'operator',
      authorAgentId: null,
      content: 'Operator here',
    });
    assert.equal(msg.authorType, 'operator');
    assert.equal(msg.authorAgentId, null);
  });

  it('should send a system message', async () => {
    const msg = await chatQ.sendMessage(db, {
      roomId: 'chat-room',
      authorType: 'system',
      authorAgentId: null,
      content: 'System notice',
    });
    assert.equal(msg.authorType, 'system');
    assert.equal(msg.authorAgentId, null);
  });

  it('should reject agent authorType without authorAgentId', async () => {
    await assert.rejects(
      () => chatQ.sendMessage(db, {
        roomId: 'chat-room',
        authorType: 'agent',
        authorAgentId: null,
        content: 'bad',
      }),
      { message: /authorAgentId is required/ },
    );
  });

  it('should reject non-agent authorType with authorAgentId', async () => {
    await assert.rejects(
      () => chatQ.sendMessage(db, {
        roomId: 'chat-room',
        authorType: 'operator',
        authorAgentId: aliceId,
        content: 'bad',
      }),
      { message: /authorAgentId must be null/ },
    );
  });

  it('should send a reply', async () => {
    const first = await chatQ.sendMessage(db, {
      roomId: 'chat-room',
      authorType: 'agent',
      authorAgentId: aliceId,
      content: 'First',
    });
    const reply = await chatQ.sendMessage(db, {
      roomId: 'chat-room',
      authorType: 'agent',
      authorAgentId: bobId,
      content: 'Reply to first',
      replyTo: first.id,
    });
    assert.equal(reply.replyTo, first.id);
  });

  it('should get latest history with sender resolved', async () => {
    // Send several messages
    for (let i = 0; i < 5; i++) {
      await chatQ.sendMessage(db, {
        roomId: 'chat-room',
        authorType: 'agent',
        authorAgentId: aliceId,
        content: `msg-${i}`,
      });
    }
    const history = await chatQ.getHistory(db, 'chat-room', { limit: 3 });
    assert.equal(history.length, 3);
    // Should be in ascending order (latest reversed)
    assert.ok(history[0].id < history[1].id);
    assert.ok(history[1].id < history[2].id);
    // sender should be resolved to agent name for agent messages
    for (const h of history) {
      if (h.authorType === 'agent') {
        assert.equal(h.sender, 'alice');
      }
    }
  });

  it('should resolve sender for operator messages', async () => {
    await chatQ.sendMessage(db, {
      roomId: 'chat-room',
      authorType: 'operator',
      authorAgentId: null,
      content: 'from operator',
    });
    const history = await chatQ.getHistory(db, 'chat-room', { limit: 500 });
    const opMsg = history.find((m) => m.content === 'from operator');
    assert.ok(opMsg);
    assert.equal(opMsg.sender, 'user');
  });

  it('should resolve sender for system messages', async () => {
    await chatQ.sendMessage(db, {
      roomId: 'chat-room',
      authorType: 'system',
      authorAgentId: null,
      content: 'system broadcast',
    });
    const history = await chatQ.getHistory(db, 'chat-room', { limit: 500 });
    const sysMsg = history.find((m) => m.content === 'system broadcast');
    assert.ok(sysMsg);
    assert.equal(sysMsg.sender, 'system');
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
