import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import { agents } from '../schema/tables.js';
import * as teamQ from './teams.js';

describe('teams queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;
  let agent1Id: string;
  let agent2Id: string;
  let agentAId: string;
  let agentBId: string;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;

    // Pre-register agents so FK constraints on team_members are satisfied
    agent1Id = uuidv7();
    agent2Id = uuidv7();
    agentAId = uuidv7();
    agentBId = uuidv7();
    await db.insert(agents).values([
      { id: agent1Id, name: 'agent-1', worktree: '/tmp/a1', status: 'idle', projectId: 'default' },
      { id: agent2Id, name: 'agent-2', worktree: '/tmp/a2', status: 'idle', projectId: 'default' },
      { id: agentAId, name: 'agent-a', worktree: '/tmp/aa', status: 'idle', projectId: 'default' },
      { id: agentBId, name: 'agent-b', worktree: '/tmp/ab', status: 'idle', projectId: 'default' },
    ]);
  });

  after(async () => {
    await tdb.close();
  });

  it('should create a team', async () => {
    const team = await teamQ.create(db, {
      id: 'team-1',
      name: 'Alpha Team',
      briefPath: 'plans/alpha.md',
    });
    assert.equal(team.id, 'team-1');
    assert.equal(team.name, 'Alpha Team');
    assert.equal(team.status, 'active');
  });

  it('should get team by id', async () => {
    const team = await teamQ.getById(db, 'team-1');
    assert.ok(team);
    assert.equal(team.name, 'Alpha Team');
  });

  it('should return null for non-existent team', async () => {
    const team = await teamQ.getById(db, 'no-such-team');
    assert.equal(team, null);
  });

  it('should add and get members', async () => {
    await teamQ.addMember(db, 'team-1', agent1Id, 'implementer', true);
    await teamQ.addMember(db, 'team-1', agent2Id, 'reviewer');

    const members = await teamQ.getMembers(db, 'team-1');
    assert.equal(members.length, 2);

    const leader = members.find((m) => m.agentId === agent1Id);
    assert.ok(leader);
    assert.equal(leader.isLeader, true);
    assert.equal(leader.role, 'implementer');

    const reviewer = members.find((m) => m.agentId === agent2Id);
    assert.ok(reviewer);
    assert.equal(reviewer.isLeader, false);
  });

  it('should update member on conflict', async () => {
    await teamQ.addMember(db, 'team-1', agent2Id, 'tester', false);
    const members = await teamQ.getMembers(db, 'team-1');
    const updated = members.find((m) => m.agentId === agent2Id);
    assert.ok(updated);
    assert.equal(updated.role, 'tester');
  });

  it('should remove a member', async () => {
    await teamQ.removeMember(db, 'team-1', agent2Id);
    const members = await teamQ.getMembers(db, 'team-1');
    assert.equal(members.length, 1);
  });

  it('should list teams', async () => {
    await teamQ.create(db, { id: 'team-2', name: 'Beta Team' });

    const all = await teamQ.list(db);
    assert.equal(all.length, 2);
  });

  it('should list teams filtered by status', async () => {
    const active = await teamQ.list(db, { status: 'active' });
    assert.equal(active.length, 2);

    const dissolved = await teamQ.list(db, { status: 'dissolved' });
    assert.equal(dissolved.length, 0);
  });

  it('should update status', async () => {
    await teamQ.updateStatus(db, 'team-1', 'default', 'converging');
    const team = await teamQ.getById(db, 'team-1');
    assert.equal(team?.status, 'converging');
  });

  it('should update deliverable', async () => {
    await teamQ.updateDeliverable(db, 'team-1', 'default', 'Final deliverable');
    const team = await teamQ.getById(db, 'team-1');
    assert.equal(team?.deliverable, 'Final deliverable');
  });

  it('should dissolve a team', async () => {
    await teamQ.dissolve(db, 'team-1', 'default');
    const team = await teamQ.getById(db, 'team-1');
    assert.equal(team?.status, 'dissolved');
    assert.ok(team?.dissolvedAt);
  });

  it('should delete a team', async () => {
    const deleted = await teamQ.deleteTeam(db, 'team-2', 'default');
    assert.equal(deleted, true);

    const deleted2 = await teamQ.deleteTeam(db, 'team-2', 'default');
    assert.equal(deleted2, false);
  });

  it('should createWithRoom', async () => {
    const team = await teamQ.createWithRoom(db, {
      id: 'team-3',
      name: 'Gamma Team',
      createdBy: 'user',
      members: [
        { agentId: agentAId, role: 'lead', isLeader: true },
        { agentId: agentBId, role: 'dev' },
      ],
    });
    assert.equal(team.id, 'team-3');

    const members = await teamQ.getMembers(db, 'team-3');
    assert.equal(members.length, 2);
  });
});
