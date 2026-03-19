import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestContext } from '../test-helper.js';
import { initUbtStatements, recordBuildStart, recordBuildEnd } from './ubt.js';
import buildsPlugin from './builds.js';

describe('builds routes', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
    initUbtStatements();
    await ctx.app.register(buildsPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.cleanup();
  });

  it('GET /builds returns empty array initially', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/builds' });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), []);
  });

  it('GET /builds returns record with correct camelCase fields', async () => {
    const id = recordBuildStart('agent-1', 'build');
    recordBuildEnd(id, 1234, true, 'some output', 'some warning');

    const res = await ctx.app.inject({ method: 'GET', url: '/builds' });
    assert.equal(res.statusCode, 200);
    const records = res.json();
    assert.equal(records.length, 1);

    const rec = records[0];
    assert.equal(rec.id, id);
    assert.equal(rec.agent, 'agent-1');
    assert.equal(rec.type, 'build');
    assert.equal(typeof rec.startedAt, 'string');
    assert.equal(rec.durationMs, 1234);
    assert.equal(rec.success, true);
    assert.equal(rec.output, 'some output');
    assert.equal(rec.stderr, 'some warning');
  });

  it('filters by agent', async () => {
    const id1 = recordBuildStart('agent-a', 'build');
    recordBuildEnd(id1, 100, true, '', '');
    const id2 = recordBuildStart('agent-b', 'build');
    recordBuildEnd(id2, 200, true, '', '');

    const res = await ctx.app.inject({ method: 'GET', url: '/builds?agent=agent-a' });
    const records = res.json();
    assert.equal(records.length, 1);
    assert.equal(records[0].agent, 'agent-a');
  });

  it('filters by type', async () => {
    const id1 = recordBuildStart('agent-1', 'build');
    recordBuildEnd(id1, 100, true, '', '');
    const id2 = recordBuildStart('agent-1', 'test');
    recordBuildEnd(id2, 200, true, '', '');

    const res = await ctx.app.inject({ method: 'GET', url: '/builds?type=test' });
    const records = res.json();
    assert.equal(records.length, 1);
    assert.equal(records[0].type, 'test');
  });

  it('limit param works', async () => {
    for (let i = 0; i < 5; i++) {
      const id = recordBuildStart('agent-1', 'build');
      recordBuildEnd(id, 100, true, '', '');
    }

    const res = await ctx.app.inject({ method: 'GET', url: '/builds?limit=2' });
    const records = res.json();
    assert.equal(records.length, 2);
  });

  it('since param works (exclusive: id > since)', async () => {
    const id1 = recordBuildStart('agent-1', 'build');
    recordBuildEnd(id1, 100, true, '', '');
    const id2 = recordBuildStart('agent-1', 'build');
    recordBuildEnd(id2, 200, true, '', '');
    const id3 = recordBuildStart('agent-1', 'build');
    recordBuildEnd(id3, 300, true, '', '');

    const res = await ctx.app.inject({ method: 'GET', url: `/builds?since=${id1}` });
    const records = res.json();
    assert.equal(records.length, 2);
    assert.ok(records.every((r: { id: number }) => r.id > id1));
  });

  it('records without output/stderr return null', async () => {
    const { db } = await import('../db.js');
    db.prepare('INSERT INTO build_history (agent, type) VALUES (?, ?)').run('agent-null', 'build');

    const res = await ctx.app.inject({ method: 'GET', url: '/builds?agent=agent-null' });
    const records = res.json();
    assert.equal(records.length, 1);
    assert.equal(records[0].output, null);
    assert.equal(records[0].stderr, null);
    assert.equal(records[0].success, null);
    assert.equal(records[0].durationMs, null);
  });

  it('success is boolean (true/false), not integer (0/1)', async () => {
    const id1 = recordBuildStart('agent-1', 'build');
    recordBuildEnd(id1, 100, true, '', '');
    const id2 = recordBuildStart('agent-1', 'build');
    recordBuildEnd(id2, 200, false, '', '');

    const res = await ctx.app.inject({ method: 'GET', url: '/builds' });
    const records = res.json();

    const successRec = records.find((r: { id: number }) => r.id === id1);
    const failRec = records.find((r: { id: number }) => r.id === id2);

    assert.equal(successRec.success, true);
    assert.equal(typeof successRec.success, 'boolean');
    assert.equal(failRec.success, false);
    assert.equal(typeof failRec.success, 'boolean');
  });
});
