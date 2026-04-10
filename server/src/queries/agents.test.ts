import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import { projects } from '../schema/tables.js';
import * as agentQ from './agents.js';

describe('agents queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;

    // Create additional project for cross-project tests
    await db.insert(projects).values({ id: 'proj-x', name: 'Project X' }).onConflictDoNothing();
  });

  after(async () => {
    await tdb.close();
  });

  it('should register an agent and return id + sessionToken', async () => {
    const result = await agentQ.register(db, {
      name: 'agent-1',
      worktree: 'docker/agent-1',
      planDoc: 'plan.md',
      mode: 'single',
      sessionToken: 'tok-1',
      projectId: 'default',
    });

    assert.ok(result.id, 'register returns an id');
    assert.ok(result.sessionToken, 'register returns a sessionToken');
    assert.equal(result.sessionToken, 'tok-1');

    const agent = await agentQ.getByName(db, 'default', 'agent-1');
    assert.ok(agent);
    assert.equal(agent.name, 'agent-1');
    assert.equal(agent.worktree, 'docker/agent-1');
    assert.equal(agent.planDoc, 'plan.md');
    assert.equal(agent.status, 'idle');
    assert.equal(agent.mode, 'single');
    assert.equal(agent.projectId, 'default');
    assert.equal(agent.id, result.id);
  });

  it('should upsert on re-register in different project', async () => {
    const result = await agentQ.register(db, {
      name: 'agent-1',
      worktree: 'docker/agent-1-v2',
      planDoc: 'plan2.md',
      mode: 'pump',
      sessionToken: 'tok-2',
      projectId: 'proj-x',
    });

    assert.ok(result.id, 'upsert returns id');
    assert.ok(result.sessionToken, 'upsert returns sessionToken');

    const agent = await agentQ.getByName(db, 'proj-x', 'agent-1');
    assert.ok(agent);
    assert.equal(agent.worktree, 'docker/agent-1-v2');
    assert.equal(agent.planDoc, 'plan2.md');
    assert.equal(agent.mode, 'pump');
    assert.equal(agent.status, 'idle');
    assert.equal(agent.projectId, 'proj-x');
  });

  it('should preserve containerHost on re-register with null', async () => {
    await agentQ.register(db, {
      name: 'agent-host-test',
      worktree: 'docker/agent-host-test',
      containerHost: 'host-a',
      projectId: 'default',
      sessionToken: 'tok-host-1',
    });
    // Re-register without containerHost — should keep 'host-a'
    await agentQ.register(db, {
      name: 'agent-host-test',
      worktree: 'docker/agent-host-test-v2',
      projectId: 'default',
      sessionToken: 'tok-host-2',
    });
    const agent = await agentQ.getByName(db, 'default', 'agent-host-test');
    assert.ok(agent);
    assert.equal(agent.containerHost, 'host-a');
    assert.equal(agent.worktree, 'docker/agent-host-test-v2');
  });

  it('should get all agents', async () => {
    await agentQ.register(db, { name: 'agent-2', worktree: 'docker/agent-2', projectId: 'default', sessionToken: 'tok-a2' });
    const all = await agentQ.getAll(db);
    assert.ok(all.length >= 2);
  });

  it('should filter by project', async () => {
    const projX = await agentQ.getAll(db, 'proj-x');
    assert.ok(projX.some((a) => a.name === 'agent-1'));
    assert.ok(!projX.some((a) => a.name === 'agent-2'));
  });

  it('should return null for unknown agent', async () => {
    const agent = await agentQ.getByName(db, 'default', 'no-such-agent');
    assert.equal(agent, null);
  });

  it('should update status', async () => {
    await agentQ.updateStatus(db, 'default', 'agent-1', 'working');
    const agent = await agentQ.getByName(db, 'default', 'agent-1');
    assert.equal(agent?.status, 'working');
  });

  it('should reject invalid status', async () => {
    await assert.rejects(
      () => agentQ.updateStatus(db, 'default', 'agent-1', 'banana' as agentQ.AgentStatus),
      { message: /Invalid agent status/ },
    );
  });

  it('should soft delete (set deleted)', async () => {
    await agentQ.softDelete(db, 'default', 'agent-1');
    const agent = await agentQ.getByName(db, 'default', 'agent-1');
    assert.ok(agent, 'row still present after soft delete');
    assert.equal(agent.status, 'deleted');
  });

  it('should get active names excluding stopping and deleted', async () => {
    // agent-1 in default is deleted, agent-2 in default is idle
    const names = await agentQ.getActiveNames(db, 'default');
    assert.ok(!names.includes('agent-1')); // agent-1 is deleted
    assert.ok(names.includes('agent-2'));
  });

  it('should get by token', async () => {
    const agent = await agentQ.getByToken(db, 'tok-2');
    assert.ok(agent);
    assert.equal(agent.name, 'agent-1');
    assert.equal(agent.projectId, 'proj-x');
  });

  it('should return null for unknown token', async () => {
    const agent = await agentQ.getByToken(db, 'nonexistent');
    assert.equal(agent, null);
  });

  it('should get worktree info', async () => {
    const info = await agentQ.getWorktreeInfo(db, 'default', 'agent-2');
    assert.ok(info);
    assert.equal(info.name, 'agent-2');
    assert.equal(info.worktree, 'docker/agent-2');
    assert.equal(info.projectId, 'default');
  });

  it('should return null worktree info for unknown agent', async () => {
    const info = await agentQ.getWorktreeInfo(db, 'default', 'no-such');
    assert.equal(info, null);
  });

  it('should deleteAllForProject (soft-delete all non-deleted)', async () => {
    await agentQ.register(db, { name: 'del-a1', worktree: 'w1', projectId: 'default', sessionToken: 'tok-del-a1' });
    await agentQ.register(db, { name: 'del-a2', worktree: 'w2', projectId: 'default', sessionToken: 'tok-del-a2' });

    const count = await agentQ.deleteAllForProject(db, 'default');
    assert.ok(count >= 2);

    // Rows still present with status 'deleted'
    const all = await agentQ.getAll(db, 'default');
    for (const a of all) {
      assert.equal(a.status, 'deleted');
    }
  });

  it('deleteAllForProject returns 0 when called twice (all already deleted)', async () => {
    const count = await agentQ.deleteAllForProject(db, 'default');
    assert.equal(count, 0);
  });

  it('should getByNameFull return sessionToken', async () => {
    const reg = await agentQ.register(db, { name: 'full-test', worktree: 'wt', sessionToken: 'tok-full', projectId: 'default' });
    const full = await agentQ.getByNameFull(db, 'default', 'full-test');
    assert.ok(full);
    assert.equal(full.sessionToken, 'tok-full');
    assert.equal(full.id, reg.id);
  });

  it('should getByIdInProject', async () => {
    const reg = await agentQ.register(db, { name: 'id-test', worktree: 'wt', projectId: 'default', sessionToken: 'tok-id-test' });
    const found = await agentQ.getByIdInProject(db, 'default', reg.id);
    assert.ok(found);
    assert.equal(found.name, 'id-test');

    // Wrong project returns null
    const notFound = await agentQ.getByIdInProject(db, 'proj-x', reg.id);
    assert.equal(notFound, null);
  });
});
