import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import { files, projects } from '../schema/tables.js';
import { sql } from 'drizzle-orm';
import * as fileQ from './files.js';
import * as agentQ from './agents.js';

describe('files queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;
  let agent1Id: string;
  let agent2Id: string;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;

    // Create additional project for cross-project file test
    await db.insert(projects).values({ id: 'proj-x', name: 'Project X' }).onConflictDoNothing();

    // Register agents to get UUIDs
    const a1 = await agentQ.register(db, { name: 'agent-1', worktree: 'w1', projectId: 'default', sessionToken: 'fl-tok-1' });
    const a2 = await agentQ.register(db, { name: 'agent-2', worktree: 'w2', projectId: 'default', sessionToken: 'fl-tok-2' });
    agent1Id = a1.id;
    agent2Id = a2.id;

    // Seed some file records using agent UUIDs
    await db.insert(files).values([
      { projectId: 'default', path: 'src/main.cpp', claimantAgentId: agent1Id, claimedAt: sql`now()` },
      { projectId: 'default', path: 'src/utils.cpp', claimantAgentId: agent1Id, claimedAt: sql`now()` },
      { projectId: 'default', path: 'src/render.cpp', claimantAgentId: agent2Id, claimedAt: sql`now()` },
      { projectId: 'default', path: 'src/input.cpp', claimantAgentId: null, claimedAt: null },
      { projectId: 'proj-x', path: 'src/other.cpp', claimantAgentId: agent1Id, claimedAt: sql`now()` },
    ]);
  });

  after(async () => {
    await tdb.close();
  });

  it('should list all files for a project', async () => {
    const rows = await fileQ.list(db, 'default');
    assert.equal(rows.length, 4);
    // Should be ordered by path ASC
    const paths = rows.map((r) => r.path);
    const sorted = [...paths].sort();
    assert.deepEqual(paths, sorted);
  });

  it('should filter by claimantAgentId', async () => {
    const rows = await fileQ.list(db, 'default', { claimantAgentId: agent1Id });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.claimantAgentId === agent1Id));
  });

  it('should filter unclaimed', async () => {
    const rows = await fileQ.list(db, 'default', { unclaimed: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, 'src/input.cpp');
    assert.equal(rows[0].claimantAgentId, null);
  });

  it('should release by claimantAgentId scoped to project', async () => {
    await fileQ.releaseByClaimantAgentId(db, 'default', agent1Id);
    const rows = await fileQ.list(db, 'default', { claimantAgentId: agent1Id });
    assert.equal(rows.length, 0);

    // agent-2 claims should be untouched
    const a2 = await fileQ.list(db, 'default', { claimantAgentId: agent2Id });
    assert.equal(a2.length, 1);

    // proj-x claims by agent-1 should be untouched (scoped by project)
    const px = await fileQ.list(db, 'proj-x', { claimantAgentId: agent1Id });
    assert.equal(px.length, 1);
  });

  it('should release all for project', async () => {
    await fileQ.releaseAll(db, 'default');
    const unclaimed = await fileQ.list(db, 'default', { unclaimed: true });
    assert.equal(unclaimed.length, 4); // all default project files

    // proj-x file should still be claimed
    const px = await fileQ.list(db, 'proj-x', { claimantAgentId: agent1Id });
    assert.equal(px.length, 1);
  });
});
