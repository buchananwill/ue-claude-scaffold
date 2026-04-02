import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import * as agentQ from './agents.js';

describe('agents queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;
  });

  after(async () => {
    await tdb.close();
  });

  it('should register an agent', async () => {
    await agentQ.register(db, {
      name: 'agent-1',
      worktree: 'docker/agent-1',
      planDoc: 'plan.md',
      mode: 'single',
      sessionToken: 'tok-1',
      projectId: 'default',
    });

    const agent = await agentQ.getByName(db, 'agent-1');
    assert.ok(agent);
    assert.equal(agent.name, 'agent-1');
    assert.equal(agent.worktree, 'docker/agent-1');
    assert.equal(agent.planDoc, 'plan.md');
    assert.equal(agent.status, 'idle');
    assert.equal(agent.mode, 'single');
    assert.equal(agent.sessionToken, 'tok-1');
  });

  it('should upsert on re-register', async () => {
    await agentQ.register(db, {
      name: 'agent-1',
      worktree: 'docker/agent-1-v2',
      planDoc: 'plan2.md',
      mode: 'pump',
      sessionToken: 'tok-2',
      projectId: 'proj-x',
    });

    const agent = await agentQ.getByName(db, 'agent-1');
    assert.ok(agent);
    assert.equal(agent.worktree, 'docker/agent-1-v2');
    assert.equal(agent.planDoc, 'plan2.md');
    assert.equal(agent.mode, 'pump');
    assert.equal(agent.status, 'idle');
    assert.equal(agent.sessionToken, 'tok-2');
    assert.equal(agent.projectId, 'proj-x');
  });

  it('should get all agents', async () => {
    await agentQ.register(db, { name: 'agent-2', worktree: 'docker/agent-2' });
    const all = await agentQ.getAll(db);
    assert.ok(all.length >= 2);
  });

  it('should filter by project', async () => {
    const projX = await agentQ.getAll(db, 'proj-x');
    assert.ok(projX.some((a) => a.name === 'agent-1'));
    assert.ok(!projX.some((a) => a.name === 'agent-2'));
  });

  it('should return null for unknown agent', async () => {
    const agent = await agentQ.getByName(db, 'no-such-agent');
    assert.equal(agent, null);
  });

  it('should update status', async () => {
    await agentQ.updateStatus(db, 'agent-1', 'building');
    const agent = await agentQ.getByName(db, 'agent-1');
    assert.equal(agent?.status, 'building');
  });

  it('should soft delete (set stopping)', async () => {
    await agentQ.softDelete(db, 'agent-1');
    const agent = await agentQ.getByName(db, 'agent-1');
    assert.equal(agent?.status, 'stopping');
  });

  it('should get active names excluding stopping', async () => {
    const names = await agentQ.getActiveNames(db);
    assert.ok(!names.includes('agent-1')); // agent-1 is stopping
    assert.ok(names.includes('agent-2'));
  });

  it('should get by token', async () => {
    const agent = await agentQ.getByToken(db, 'tok-2');
    assert.ok(agent);
    assert.equal(agent.name, 'agent-1');
  });

  it('should return null for unknown token', async () => {
    const agent = await agentQ.getByToken(db, 'nonexistent');
    assert.equal(agent, null);
  });

  it('should get worktree info', async () => {
    const info = await agentQ.getWorktreeInfo(db, 'agent-2');
    assert.ok(info);
    assert.equal(info.name, 'agent-2');
    assert.equal(info.worktree, 'docker/agent-2');
    assert.equal(info.projectId, 'default');
  });

  it('should return null worktree info for unknown agent', async () => {
    const info = await agentQ.getWorktreeInfo(db, 'no-such');
    assert.equal(info, null);
  });

  it('should get project id', async () => {
    const pid = await agentQ.getProjectId(db, 'agent-1');
    assert.equal(pid, 'proj-x');
  });

  it('should return default for unknown agent project', async () => {
    const pid = await agentQ.getProjectId(db, 'no-such');
    assert.equal(pid, 'default');
  });

  it('should hard delete', async () => {
    await agentQ.hardDelete(db, 'agent-1');
    const agent = await agentQ.getByName(db, 'agent-1');
    assert.equal(agent, null);
  });

  it('should delete all and return count', async () => {
    await agentQ.register(db, { name: 'a1', worktree: 'w1' });
    await agentQ.register(db, { name: 'a2', worktree: 'w2' });
    const count = await agentQ.deleteAll(db);
    assert.ok(count >= 2);
    const all = await agentQ.getAll(db);
    assert.equal(all.length, 0);
  });
});
