import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import hooksPlugin from './hooks.js';

describe('POST /hooks/resolve', () => {
  let app: FastifyInstance;

  before(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    await app.register(hooksPlugin);
  });

  after(async () => {
    await app?.close();
  });

  it('valid body returns 200 with correct resolved hooks', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/hooks/resolve',
      payload: { hasBuildScript: true },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.buildIntercept, true);
    assert.equal(body.cppLint, false);
  });

  it('missing hasBuildScript returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/hooks/resolve',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it('hasBuildScript as string returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/hooks/resolve',
      payload: { hasBuildScript: 'true' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('projectHooks.buildIntercept as string returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/hooks/resolve',
      payload: {
        hasBuildScript: true,
        projectHooks: { buildIntercept: 'true' },
      },
    });
    assert.equal(res.statusCode, 400);
  });

  it('empty body returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/hooks/resolve',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    assert.equal(res.statusCode, 400);
  });

  it('valid cascade with all levels set, CLI wins', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/hooks/resolve',
      payload: {
        hasBuildScript: true,
        projectHooks: { buildIntercept: true, cppLint: true },
        teamHooks: { buildIntercept: false, cppLint: false },
        memberHooks: { buildIntercept: true, cppLint: true },
        cliOverride: { buildIntercept: false, cppLint: false },
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.buildIntercept, false);
    assert.equal(body.cppLint, false);
  });
});
