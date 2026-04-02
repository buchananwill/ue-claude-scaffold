import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import { files } from '../schema/tables.js';
import { sql } from 'drizzle-orm';
import * as fileQ from './files.js';

describe('files queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;

    // Seed some file records
    await db.insert(files).values([
      { projectId: 'default', path: 'src/main.cpp', claimant: 'agent-1', claimedAt: sql`now()` },
      { projectId: 'default', path: 'src/utils.cpp', claimant: 'agent-1', claimedAt: sql`now()` },
      { projectId: 'default', path: 'src/render.cpp', claimant: 'agent-2', claimedAt: sql`now()` },
      { projectId: 'default', path: 'src/input.cpp', claimant: null, claimedAt: null },
      { projectId: 'proj-x', path: 'src/other.cpp', claimant: 'agent-1', claimedAt: sql`now()` },
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

  it('should filter by claimant', async () => {
    const rows = await fileQ.list(db, 'default', { claimant: 'agent-1' });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.claimant === 'agent-1'));
  });

  it('should filter unclaimed', async () => {
    const rows = await fileQ.list(db, 'default', { unclaimed: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, 'src/input.cpp');
    assert.equal(rows[0].claimant, null);
  });

  it('should release by claimant', async () => {
    await fileQ.releaseByClaimant(db, 'agent-1');
    const rows = await fileQ.list(db, 'default', { claimant: 'agent-1' });
    assert.equal(rows.length, 0);

    // agent-2 claims should be untouched
    const a2 = await fileQ.list(db, 'default', { claimant: 'agent-2' });
    assert.equal(a2.length, 1);

    // proj-x claims by agent-1 should also be released
    const px = await fileQ.list(db, 'proj-x', { claimant: 'agent-1' });
    assert.equal(px.length, 0);
  });

  it('should release all', async () => {
    await fileQ.releaseAll(db);
    const unclaimed = await fileQ.list(db, 'default', { unclaimed: true });
    assert.equal(unclaimed.length, 4); // all default project files
  });
});
