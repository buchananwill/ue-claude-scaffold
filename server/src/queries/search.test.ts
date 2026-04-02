import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import { tasks, messages, agents } from '../schema/tables.js';
import * as searchQ from './search.js';

describe('search queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;

    // Seed tasks
    await db.insert(tasks).values([
      { title: 'Implement rendering pipeline', description: 'Build the render system', status: 'pending', priority: 0, basePriority: 0, projectId: 'default' },
      { title: 'Fix input handling', description: 'Fix keyboard input bugs', status: 'pending', priority: 0, basePriority: 0, projectId: 'default' },
      { title: 'Unrelated task', description: 'Something else', status: 'pending', priority: 0, basePriority: 0, projectId: 'default' },
    ]);

    // Seed messages
    await db.insert(messages).values([
      { fromAgent: 'agent-1', channel: 'progress', type: 'update', payload: { text: 'rendering is complete' }, projectId: 'default' },
      { fromAgent: 'agent-2', channel: 'progress', type: 'update', payload: { text: 'input refactored' }, projectId: 'default' },
    ]);

    // Seed agents
    await db.insert(agents).values([
      { name: 'render-agent', worktree: '/tmp/render', status: 'idle', mode: 'single', projectId: 'default' },
      { name: 'input-agent', worktree: '/tmp/input', status: 'idle', mode: 'single', projectId: 'default' },
    ]);
  });

  after(async () => {
    await tdb.close();
  });

  it('should search tasks by title', async () => {
    const results = await searchQ.searchTasks(db, 'render');
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Implement rendering pipeline');
  });

  it('should search tasks by description', async () => {
    const results = await searchQ.searchTasks(db, 'keyboard');
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Fix input handling');
  });

  it('should search tasks case-insensitively', async () => {
    const results = await searchQ.searchTasks(db, 'RENDER');
    assert.equal(results.length, 1);
  });

  it('should respect limit', async () => {
    const results = await searchQ.searchTasks(db, 'task', { limit: 1 });
    assert.equal(results.length, 1);
  });

  it('should search messages by payload', async () => {
    const results = await searchQ.searchMessages(db, 'rendering');
    assert.equal(results.length, 1);
    assert.equal(results[0].fromAgent, 'agent-1');
  });

  it('should search agents by name', async () => {
    const results = await searchQ.searchAgents(db, 'render');
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'render-agent');
  });

  it('should search agents case-insensitively', async () => {
    const results = await searchQ.searchAgents(db, 'INPUT');
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'input-agent');
  });
});
