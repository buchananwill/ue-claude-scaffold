import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import * as buildsQ from '../queries/builds.js';
import { buildHistory } from '../schema/tables.js';
import buildsPlugin from './builds.js';

describe('builds routes (drizzle)', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(buildsPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  async function recordBuild(agent: string, type: string, opts?: { durationMs?: number; success?: boolean; output?: string; stderr?: string }) {
    const id = await buildsQ.insertHistory(ctx.db, { agent, type, projectId: 'default' });
    if (opts?.durationMs !== undefined) {
      await buildsQ.updateHistory(ctx.db, id, {
        durationMs: opts.durationMs,
        success: opts.success ?? true,
        output: opts.output ?? '',
        stderr: opts.stderr ?? '',
      });
    }
    return id;
  }

  it('GET /builds returns empty array initially', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/builds' });
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), []);
  });

  it('GET /builds returns record with correct camelCase fields', async () => {
    const id = await recordBuild('agent-1', 'build', {
      durationMs: 1234, success: true, output: 'some output', stderr: 'some warning',
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/builds' });
    assert.equal(res.statusCode, 200);
    const records = res.json();
    assert.equal(records.length, 1);

    const rec = records[0];
    assert.equal(rec.id, id);
    assert.equal(rec.agent, 'agent-1');
    assert.equal(rec.type, 'build');
    assert.ok(rec.startedAt != null);
    assert.equal(rec.durationMs, 1234);
    assert.equal(rec.success, true);
    assert.equal(rec.output, 'some output');
    assert.equal(rec.stderr, 'some warning');
  });

  it('filters by agent', async () => {
    await recordBuild('agent-a', 'build', { durationMs: 100, success: true });
    await recordBuild('agent-b', 'build', { durationMs: 200, success: true });

    const res = await ctx.app.inject({ method: 'GET', url: '/builds?agent=agent-a' });
    const records = res.json();
    assert.equal(records.length, 1);
    assert.equal(records[0].agent, 'agent-a');
  });

  it('filters by type', async () => {
    await recordBuild('agent-1', 'build', { durationMs: 100, success: true });
    await recordBuild('agent-1', 'test', { durationMs: 200, success: true });

    const res = await ctx.app.inject({ method: 'GET', url: '/builds?type=test' });
    const records = res.json();
    assert.equal(records.length, 1);
    assert.equal(records[0].type, 'test');
  });

  it('limit param works', async () => {
    for (let i = 0; i < 5; i++) {
      await recordBuild('agent-1', 'build', { durationMs: 100, success: true });
    }

    const res = await ctx.app.inject({ method: 'GET', url: '/builds?limit=2' });
    const records = res.json();
    assert.equal(records.length, 2);
  });

  it('since param works (exclusive: id > since)', async () => {
    const id1 = await recordBuild('agent-1', 'build', { durationMs: 100, success: true });
    await recordBuild('agent-1', 'build', { durationMs: 200, success: true });
    await recordBuild('agent-1', 'build', { durationMs: 300, success: true });

    const res = await ctx.app.inject({ method: 'GET', url: `/builds?since=${id1}` });
    const records = res.json();
    assert.equal(records.length, 2);
    assert.ok(records.every((r: { id: number }) => r.id > id1));
  });

  it('records without output/stderr return null', async () => {
    // Insert a record without calling updateHistory (no duration/success/output/stderr)
    await buildsQ.insertHistory(ctx.db, { agent: 'agent-null', type: 'build', projectId: 'default' });

    const res = await ctx.app.inject({ method: 'GET', url: '/builds?agent=agent-null' });
    const records = res.json();
    assert.equal(records.length, 1);
    assert.equal(records[0].output, null);
    assert.equal(records[0].stderr, null);
    assert.equal(records[0].success, null);
    assert.equal(records[0].durationMs, null);
  });

  it('success is boolean (true/false), not integer (0/1)', async () => {
    const id1 = await recordBuild('agent-1', 'build', { durationMs: 100, success: true });
    const id2 = await recordBuild('agent-1', 'build', { durationMs: 200, success: false });

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
