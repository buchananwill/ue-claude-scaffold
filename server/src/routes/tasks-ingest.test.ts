import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import { createTestConfig } from '../test-helper.js';
import tasksIngestPlugin from './tasks-ingest.js';

describe('POST /tasks/ingest route', () => {
  let ctx: DrizzleTestContext;
  let tmpDir: string;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    tmpDir = await mkdtemp(join(tmpdir(), 'tasks-ingest-route-'));
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects relative path with 400', async () => {
    const config = createTestConfig({
      resolvedProjects: {
        default: {
          name: 'TestProject',
          path: tmpDir,
          bareRepoPath: '/tmp/test-repo.git',
        },
      },
    });
    await ctx.app.register(tasksIngestPlugin, { config });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/ingest',
      headers: { 'x-project-id': 'default' },
      payload: { tasksDir: 'relative/path' },
    });

    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('absolute'));
  });

  it('rejects path outside project roots with 400', async () => {
    const config = createTestConfig({
      resolvedProjects: {
        default: {
          name: 'TestProject',
          path: tmpDir,
          bareRepoPath: '/tmp/test-repo.git',
        },
      },
    });
    await ctx.app.register(tasksIngestPlugin, { config });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/ingest',
      headers: { 'x-project-id': 'default' },
      payload: { tasksDir: '/usr/share/not-allowed' },
    });

    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('not within'));
  });

  it('rejects non-existent directory with 400', async () => {
    const nonExistent = join(tmpDir, 'does-not-exist');
    const config = createTestConfig({
      resolvedProjects: {
        default: {
          name: 'TestProject',
          path: tmpDir,
          bareRepoPath: '/tmp/test-repo.git',
        },
      },
    });
    await ctx.app.register(tasksIngestPlugin, { config });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/ingest',
      headers: { 'x-project-id': 'default' },
      payload: { tasksDir: nonExistent },
    });

    assert.equal(res.statusCode, 400);
    assert.ok(res.json().message.includes('not a directory or not accessible'));
  });

  it('valid directory with .md files returns ingested result', async () => {
    await writeFile(join(tmpDir, 'task-a.md'), [
      '---',
      'title: Task A',
      'priority: 1',
      '---',
      'Description of task A.',
    ].join('\n'));

    await writeFile(join(tmpDir, 'task-b.md'), [
      '---',
      'title: Task B',
      '---',
      'Description of task B.',
    ].join('\n'));

    const config = createTestConfig({
      resolvedProjects: {
        default: {
          name: 'TestProject',
          path: tmpDir,
          bareRepoPath: '/tmp/test-repo.git',
        },
      },
    });
    await ctx.app.register(tasksIngestPlugin, { config });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/tasks/ingest',
      headers: { 'x-project-id': 'default' },
      payload: { tasksDir: tmpDir },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ingested, 2);
    assert.equal(body.skipped, 0);
    assert.equal(body.errors, 0);
    assert.equal(typeof body.replanned, 'number');
    assert.ok(Array.isArray(body.tasks));
    assert.equal(body.tasks.length, 2);
  });
});
