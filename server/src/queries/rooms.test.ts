import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import { agents } from '../schema/tables.js';
import * as roomQ from './rooms.js';

// Fixed UUIDs for deterministic test references
const AGENT_1_ID = uuidv7();
const AGENT_2_ID = uuidv7();

describe('rooms queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;

    // Seed agent rows so addMember FK constraints are satisfied
    await db.insert(agents).values([
      { id: AGENT_1_ID, name: 'agent-1', worktree: '/tmp/agent-1', status: 'idle', projectId: 'default' },
      { id: AGENT_2_ID, name: 'agent-2', worktree: '/tmp/agent-2', status: 'idle', projectId: 'default' },
    ]);
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
    await roomQ.addMember(db, 'room-1', AGENT_1_ID);
    await roomQ.addMember(db, 'room-1', AGENT_2_ID);
    // Adding same member again should be ignored (ON CONFLICT DO NOTHING)
    await roomQ.addMember(db, 'room-1', AGENT_1_ID);

    const members = await roomQ.getMembers(db, 'room-1');
    assert.equal(members.length, 2);
    assert.ok(members.some(m => m.agentId === AGENT_1_ID));
    assert.ok(members.some(m => m.agentId === AGENT_2_ID));
  });

  it('should remove a member', async () => {
    await roomQ.removeMember(db, 'room-1', AGENT_2_ID);
    const members = await roomQ.getMembers(db, 'room-1');
    assert.equal(members.length, 1);
    assert.ok(members.some(m => m.agentId === AGENT_1_ID));
  });

  it('should list rooms', async () => {
    await roomQ.createRoom(db, {
      id: 'room-2',
      name: 'Direct',
      type: 'direct',
      createdBy: 'agent-1',
    });

    const all = await roomQ.listRooms(db, { projectId: 'default' });
    assert.equal(all.length, 2);
  });

  it('should list rooms filtered by member', async () => {
    await roomQ.addMember(db, 'room-2', AGENT_1_ID);

    const rooms = await roomQ.listRooms(db, { member: 'agent-1', projectId: 'default' });
    assert.equal(rooms.length, 2); // member of both rooms
  });

  it('should get presence with agent status', async () => {
    // agent-1 was seeded in before() — no need to insert again
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
