import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './test-utils.js';
import type { DrizzleDb } from '../drizzle-instance.js';
import * as projectsQ from './projects.js';
import { isValidProjectId } from '../branch-naming.js';
import { agents } from '../schema/tables.js';
import { eq, and } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

describe('projects queries', () => {
  let tdb: TestDb;
  let db: DrizzleDb;

  before(async () => {
    tdb = await createTestDb();
    db = tdb.db;
  });

  after(async () => {
    await tdb.close();
  });

  it('should validate project IDs', () => {
    assert.ok(isValidProjectId('my-project'));
    assert.ok(isValidProjectId('a'));
    assert.ok(isValidProjectId('a_b-c123'));
    assert.ok(!isValidProjectId(''));
    assert.ok(!isValidProjectId('has spaces'));
    assert.ok(!isValidProjectId('has.dots'));
    assert.ok(!isValidProjectId('a'.repeat(65)));
  });

  it('should create a project', async () => {
    const row = await projectsQ.create(db, {
      id: 'proj-new-1',
      name: 'Project One',
      engineVersion: '5.4',
      seedBranch: 'docker/current-root',
      buildTimeoutMs: 600000,
      testTimeoutMs: 700000,
    });
    assert.equal(row.id, 'proj-new-1');
    assert.equal(row.name, 'Project One');
    assert.equal(row.engineVersion, '5.4');
    assert.equal(row.seedBranch, 'docker/current-root');
    assert.equal(row.buildTimeoutMs, 600000);
    assert.equal(row.testTimeoutMs, 700000);
    assert.ok(row.createdAt);
  });

  it('should get a project by ID', async () => {
    const row = await projectsQ.getById(db, 'proj-new-1');
    assert.ok(row);
    assert.equal(row.id, 'proj-new-1');
    assert.equal(row.name, 'Project One');
  });

  it('should return null for unknown project', async () => {
    const row = await projectsQ.getById(db, 'no-such');
    assert.equal(row, null);
  });

  it('should list all projects', async () => {
    await projectsQ.create(db, { id: 'proj-2', name: 'Project Two' });
    const all = await projectsQ.getAll(db);
    assert.ok(all.length >= 2);
    assert.ok(all.some(p => p.id === 'proj-1'));
    assert.ok(all.some(p => p.id === 'proj-2'));
  });

  it('should update a project', async () => {
    const updated = await projectsQ.update(db, 'proj-new-1', {
      name: 'Updated Name',
      engineVersion: '5.5',
    });
    assert.ok(updated);
    assert.equal(updated.name, 'Updated Name');
    assert.equal(updated.engineVersion, '5.5');
    // Unchanged fields remain
    assert.equal(updated.seedBranch, 'docker/current-root');
  });

  it('should return null when updating nonexistent project', async () => {
    const result = await projectsQ.update(db, 'no-such', { name: 'X' });
    assert.equal(result, null);
  });

  it('should return existing row when update has no fields', async () => {
    const result = await projectsQ.update(db, 'proj-new-1', {});
    assert.ok(result);
    assert.equal(result.id, 'proj-new-1');
  });

  it('should delete a project', async () => {
    const ok = await projectsQ.remove(db, 'proj-2');
    assert.equal(ok, true);
    const row = await projectsQ.getById(db, 'proj-2');
    assert.equal(row, null);
  });

  it('should return false when deleting nonexistent project', async () => {
    const ok = await projectsQ.remove(db, 'no-such');
    assert.equal(ok, false);
  });

  it('should seed from config (insert-only)', async () => {
    const { inserted, skipped } = await projectsQ.seedFromConfig(db, [
      { id: 'proj-1' },
      { id: 'proj-new' },
      { id: 'proj-newer', name: 'Project Newer' },
    ]);
    // proj-1 already exists -> skipped
    assert.ok(skipped.includes('proj-1'));
    assert.ok(inserted.includes('proj-new'));
    assert.ok(inserted.includes('proj-newer'));

    // Verify inserted projects exist
    const projNew = await projectsQ.getById(db, 'proj-new');
    assert.ok(projNew);
    assert.equal(projNew.name, 'proj-new'); // name defaults to ID

    // Verify name from config is used when provided
    const projNewer = await projectsQ.getById(db, 'proj-newer');
    assert.ok(projNewer);
    assert.equal(projNewer.name, 'Project Newer');
  });

  it('should report invalid project IDs during seed', async () => {
    const { inserted, invalid } = await projectsQ.seedFromConfig(db, [
      { id: 'valid-id' },
      { id: 'has spaces' },
    ]);
    assert.ok(inserted.includes('valid-id'));
    assert.ok(invalid.includes('has spaces'));
  });

  it('should detect referencing data', async () => {
    // proj-1 has no data yet
    const hasData = await projectsQ.hasReferencingData(db, 'proj-1');
    assert.equal(hasData, false);
  });

  it('should detect referencing data when agents exist', async () => {
    // Insert an agent referencing proj-1
    await db.insert(agents).values({
      id: uuidv7(),
      name: 'test-agent',
      projectId: 'proj-1',
      worktree: 'docker/test',
      status: 'idle',
      mode: 'single',
    });

    const hasData = await projectsQ.hasReferencingData(db, 'proj-1');
    assert.equal(hasData, true);

    // Clean up
    await db.delete(agents).where(eq(agents.name, 'test-agent'));
  });
});
