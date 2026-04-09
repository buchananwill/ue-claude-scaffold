import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import { agents } from '../schema/tables.js';
import * as roomQ from './rooms.js';

describe('rooms queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;
  });

  after(async () => {
    await tdb.close();
  });

  it('should create a room', async () => {
    const room = await roomQ.createRoom(db, {
      id: 'room-1',
      name: 'General',
      type: 'group',
      createdBy: 'user',
    });
    assert.equal(room.id, 'room-1');
    assert.equal(room.name, 'General');
    assert.equal(room.type, 'group');
  });

  it('should get a room by id', async () => {
    const room = await roomQ.getRoom(db, 'room-1');
    assert.ok(room);
    assert.equal(room.name, 'General');
  });

  it('should return null for non-existent room', async () => {
    const room = await roomQ.getRoom(db, 'no-such-room');
    assert.equal(room, null);
  });

  it('should add and get members', async () => {
    await roomQ.addMember(db, 'room-1', 'agent-1');
    await roomQ.addMember(db, 'room-1', 'agent-2');
    // Adding same member again should be ignored (ON CONFLICT DO NOTHING)
    await roomQ.addMember(db, 'room-1', 'agent-1');

    const members = await roomQ.getMembers(db, 'room-1');
    assert.equal(members.length, 2);
    assert.ok(members.some(m => m.agentId === 'agent-1'));
    assert.ok(members.some(m => m.agentId === 'agent-2'));
  });

  it('should remove a member', async () => {
    await roomQ.removeMember(db, 'room-1', 'agent-2');
    const members = await roomQ.getMembers(db, 'room-1');
    assert.equal(members.length, 1);
    assert.ok(members.some(m => m.agentId === 'agent-1'));
  });

  it('should list rooms', async () => {
    await roomQ.createRoom(db, {
      id: 'room-2',
      name: 'Direct',
      type: 'direct',
      createdBy: 'agent-1',
    });

    const all = await roomQ.listRooms(db);
    assert.equal(all.length, 2);
  });

  it('should list rooms filtered by member', async () => {
    await roomQ.addMember(db, 'room-2', 'agent-1');

    const rooms = await roomQ.listRooms(db, { member: 'agent-1' });
    assert.equal(rooms.length, 2); // member of both rooms
  });

  it('should get presence with agent status', async () => {
    // Register an agent so presence can join against it
    const { v7: uuidv7 } = await import('uuid');
    await db.insert(agents).values({
      id: uuidv7(),
      name: 'agent-1',
      worktree: '/tmp/agent-1',
      status: 'idle',
      mode: 'single',
      projectId: 'default',
    });

    const presence = await roomQ.getPresence(db, 'room-1');
    assert.equal(presence.length, 1);
    assert.equal(presence[0].name, 'agent-1');
    assert.equal(presence[0].online, true);
    assert.equal(presence[0].status, 'idle');
  });

  it('should delete a room', async () => {
    const deleted = await roomQ.deleteRoom(db, 'room-2');
    assert.equal(deleted, true);

    const deleted2 = await roomQ.deleteRoom(db, 'room-2');
    assert.equal(deleted2, false);
  });
});
