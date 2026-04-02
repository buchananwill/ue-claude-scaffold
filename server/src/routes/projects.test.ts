import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import projectsPlugin from './projects.js';
import { agents } from '../schema/tables.js';
import { eq } from 'drizzle-orm';

describe('projects routes', () => {
  let ctx: DrizzleTestContext;

  before(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(projectsPlugin);
  });

  after(async () => {
    await ctx?.app.close();
    await ctx?.cleanup();
  });

  it('POST /projects creates a project', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/projects',
      payload: {
        id: 'test-proj',
        name: 'Test Project',
        engineVersion: '5.4',
        seedBranch: 'main',
        buildTimeoutMs: 600000,
        testTimeoutMs: 700000,
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.id, 'test-proj');
    assert.equal(body.name, 'Test Project');
    assert.equal(body.engineVersion, '5.4');
    assert.equal(body.seedBranch, 'main');
    assert.equal(body.buildTimeoutMs, 600000);
  });

  it('POST /projects rejects duplicate', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/projects',
      payload: { id: 'test-proj', name: 'Dupe' },
    });
    assert.equal(res.statusCode, 409);
  });

  it('POST /projects rejects invalid ID', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/projects',
      payload: { id: 'has spaces', name: 'Bad' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /projects rejects empty-string ID', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/projects',
      payload: { id: '', name: 'X' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /projects rejects missing fields', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/projects',
      payload: { id: 'no-name' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('GET /projects lists all', async () => {
    // Create a second project
    await ctx.app.inject({
      method: 'POST',
      url: '/projects',
      payload: { id: 'proj-b', name: 'B' },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/projects',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body));
    assert.ok(body.length >= 2);
    assert.ok(body.some((p: { id: string }) => p.id === 'test-proj'));
    assert.ok(body.some((p: { id: string }) => p.id === 'proj-b'));
  });

  it('GET /projects/:id returns a project', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/projects/test-proj',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.id, 'test-proj');
    assert.equal(body.name, 'Test Project');
  });

  it('GET /projects/:id returns 404 for unknown', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/projects/no-such',
    });
    assert.equal(res.statusCode, 404);
  });

  it('PATCH /projects/:id updates a project', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/projects/test-proj',
      payload: { name: 'Updated Name', engineVersion: '5.5' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.name, 'Updated Name');
    assert.equal(body.engineVersion, '5.5');
    // Other fields preserved
    assert.equal(body.seedBranch, 'main');
  });

  it('PATCH /projects/:id returns 404 for unknown', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/projects/no-such',
      payload: { name: 'X' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('DELETE /projects/:id deletes a project with no data', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/projects/proj-b',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);

    // Verify deleted
    const get = await ctx.app.inject({
      method: 'GET',
      url: '/projects/proj-b',
    });
    assert.equal(get.statusCode, 404);
  });

  it('DELETE /projects/:id returns 404 for unknown', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/projects/no-such',
    });
    assert.equal(res.statusCode, 404);
  });

  it('DELETE /projects/:id returns 409 when data exists', async () => {
    // Insert an agent referencing test-proj
    await ctx.db.insert(agents).values({
      name: 'del-test-agent',
      projectId: 'test-proj',
      worktree: 'docker/test',
      status: 'idle',
      mode: 'single',
    });

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/projects/test-proj',
    });
    assert.equal(res.statusCode, 409);

    // Clean up
    await ctx.db.delete(agents).where(eq(agents.name, 'del-test-agent'));
  });
});
