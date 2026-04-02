import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestConfig } from '../test-helper.js';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import { rooms, roomMembers } from '../schema/tables.js';
import { eq } from 'drizzle-orm';
import roomsPlugin from './rooms.js';
import agentsPlugin from './agents.js';

/* ------------------------------------------------------------------ */
/*  Helper: create a room via inject                                   */
/* ------------------------------------------------------------------ */
async function createRoom(
  ctx: { app: import('fastify').FastifyInstance },
  opts: { id: string; name: string; type: string; members?: string[]; agent?: string },
) {
  const headers: Record<string, string> = {};
  if (opts.agent) headers['x-agent-name'] = opts.agent;
  return ctx.app.inject({
    method: 'POST',
    url: '/rooms',
    payload: { id: opts.id, name: opts.name, type: opts.type, members: opts.members },
    headers,
  });
}

/* ------------------------------------------------------------------ */
/*  Room CRUD                                                          */
/* ------------------------------------------------------------------ */
describe('rooms CRUD', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(roomsPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it('POST /rooms creates a room and returns {ok, id}', async () => {
    const res = await createRoom(ctx, { id: 'r1', name: 'Room 1', type: 'group', agent: 'alice' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.id, 'r1');
  });

  it('POST /rooms — creator is auto-added to members', async () => {
    await createRoom(ctx, { id: 'r1', name: 'Room 1', type: 'group', agent: 'alice' });
    const detail = await ctx.app.inject({ method: 'GET', url: '/rooms/r1' });
    const members = detail.json().members.map((m: { member: string }) => m.member);
    assert.ok(members.includes('alice'));
  });

  it('POST /rooms — members in body are added', async () => {
    await createRoom(ctx, { id: 'r1', name: 'Room 1', type: 'group', agent: 'alice', members: ['bob', 'carol'] });
    const detail = await ctx.app.inject({ method: 'GET', url: '/rooms/r1' });
    const members = detail.json().members.map((m: { member: string }) => m.member);
    assert.ok(members.includes('alice'));
    assert.ok(members.includes('bob'));
    assert.ok(members.includes('carol'));
  });

  it('POST /rooms — invalid type returns 400', async () => {
    const res = await createRoom(ctx, { id: 'r1', name: 'Bad', type: 'invalid' });
    assert.equal(res.statusCode, 400);
  });

  it('GET /rooms returns all rooms with memberCount', async () => {
    await createRoom(ctx, { id: 'r1', name: 'Room 1', type: 'group', agent: 'alice', members: ['bob'] });
    await createRoom(ctx, { id: 'r2', name: 'Room 2', type: 'direct', agent: 'carol' });

    const res = await ctx.app.inject({ method: 'GET', url: '/rooms' });
    assert.equal(res.statusCode, 200);
    const rooms = res.json();
    assert.equal(rooms.length, 2);

    const r1 = rooms.find((r: { id: string }) => r.id === 'r1');
    assert.equal(r1.memberCount, 2);

    const r2 = rooms.find((r: { id: string }) => r.id === 'r2');
    assert.equal(r2.memberCount, 1);
  });

  it('GET /rooms?member=X filters to rooms where X is a member', async () => {
    await createRoom(ctx, { id: 'r1', name: 'Room 1', type: 'group', agent: 'alice', members: ['bob'] });
    await createRoom(ctx, { id: 'r2', name: 'Room 2', type: 'group', agent: 'carol' });

    const res = await ctx.app.inject({ method: 'GET', url: '/rooms?member=bob' });
    const rooms = res.json();
    assert.equal(rooms.length, 1);
    assert.equal(rooms[0].id, 'r1');
  });

  it('GET /rooms/:id returns room detail with members array', async () => {
    await createRoom(ctx, { id: 'r1', name: 'Room 1', type: 'group', agent: 'alice' });
    const res = await ctx.app.inject({ method: 'GET', url: '/rooms/r1' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.id, 'r1');
    assert.equal(body.name, 'Room 1');
    assert.equal(body.type, 'group');
    assert.ok(Array.isArray(body.members));
    assert.equal(body.members.length, 1);
    assert.equal(body.members[0].member, 'alice');
    assert.ok(body.members[0].joinedAt);
  });

  it('GET /rooms/:id returns 404 for unknown room', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/rooms/nonexistent' });
    assert.equal(res.statusCode, 404);
  });

  it('DELETE /rooms/:id deletes room; subsequent GET returns 404', async () => {
    await createRoom(ctx, { id: 'r1', name: 'Room 1', type: 'group', agent: 'alice' });
    const del = await ctx.app.inject({ method: 'DELETE', url: '/rooms/r1' });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().ok, true);

    const get = await ctx.app.inject({ method: 'GET', url: '/rooms/r1' });
    assert.equal(get.statusCode, 404);
  });

  it('DELETE /rooms/:id cascade deletes messages', async () => {
    await createRoom(ctx, { id: 'r1', name: 'Room 1', type: 'group', agent: 'alice' });
    // Post a message
    await ctx.app.inject({
      method: 'POST',
      url: '/rooms/r1/messages',
      payload: { content: 'hello' },
      headers: { 'x-agent-name': 'alice' },
    });

    // Delete the room
    await ctx.app.inject({ method: 'DELETE', url: '/rooms/r1' });

    // Recreate the room to query — messages should be gone from DB via CASCADE
    await createRoom(ctx, { id: 'r1', name: 'Room 1 v2', type: 'group', agent: 'alice' });
    const msgs = await ctx.app.inject({
      method: 'GET',
      url: '/rooms/r1/messages',
    });
    assert.equal(msgs.statusCode, 200);
    assert.equal(msgs.json().length, 0);
  });

  it('POST /rooms/:id/members adds members', async () => {
    await createRoom(ctx, { id: 'r1', name: 'Room 1', type: 'group', agent: 'alice' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/rooms/r1/members',
      payload: { members: ['bob', 'carol'] },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);

    const detail = await ctx.app.inject({ method: 'GET', url: '/rooms/r1' });
    const members = detail.json().members.map((m: { member: string }) => m.member);
    assert.equal(members.length, 3);
    assert.ok(members.includes('bob'));
    assert.ok(members.includes('carol'));
  });

  it('POST /rooms/:id/members returns 404 for unknown room', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/rooms/nonexistent/members',
      payload: { members: ['bob'] },
    });
    assert.equal(res.statusCode, 404);
  });

  it('DELETE /rooms/:id/members/:member removes a member', async () => {
    await createRoom(ctx, { id: 'r1', name: 'Room 1', type: 'group', agent: 'alice', members: ['bob'] });
    const res = await ctx.app.inject({ method: 'DELETE', url: '/rooms/r1/members/bob' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);

    const detail = await ctx.app.inject({ method: 'GET', url: '/rooms/r1' });
    const members = detail.json().members.map((m: { member: string }) => m.member);
    assert.ok(!members.includes('bob'));
    assert.ok(members.includes('alice'));
  });
});

/* ------------------------------------------------------------------ */
/*  Chat messages                                                      */
/* ------------------------------------------------------------------ */
describe('chat messages', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(roomsPlugin);
    // Create a room with alice and bob as members
    await ctx.app.inject({
      method: 'POST',
      url: '/rooms',
      payload: { id: 'r1', name: 'Test Room', type: 'group', members: ['alice', 'bob'] },
      headers: { 'x-agent-name': 'alice' },
    });
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it('POST /rooms/:id/messages — member posts message, returns {ok, id}', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/rooms/r1/messages',
      payload: { content: 'hello world' },
      headers: { 'x-agent-name': 'alice' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.id, 'number');
  });

  it('POST /rooms/:id/messages — non-member gets 403', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/rooms/r1/messages',
      payload: { content: 'intruder' },
      headers: { 'x-agent-name': 'eve' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('POST /rooms/:id/messages — no header: sender defaults to "user", 403 if "user" not member', async () => {
    // "user" is not a member of r1 (members: alice, bob)
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/rooms/r1/messages',
      payload: { content: 'hi' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('POST /rooms/:id/messages — no header: 200 if "user" is a member', async () => {
    // Add "user" to room
    await ctx.app.inject({
      method: 'POST',
      url: '/rooms/r1/members',
      payload: { members: ['user'] },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/rooms/r1/messages',
      payload: { content: 'from user' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
  });

  it('POST /rooms/:id/messages — 404 for unknown room', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/rooms/nonexistent/messages',
      payload: { content: 'hello' },
      headers: { 'x-agent-name': 'alice' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('POST /rooms/:id/messages — replyTo field works', async () => {
    const msg1 = await ctx.app.inject({
      method: 'POST',
      url: '/rooms/r1/messages',
      payload: { content: 'original' },
      headers: { 'x-agent-name': 'alice' },
    });
    const parentId = msg1.json().id;

    const msg2 = await ctx.app.inject({
      method: 'POST',
      url: '/rooms/r1/messages',
      payload: { content: 'reply', replyTo: parentId },
      headers: { 'x-agent-name': 'bob' },
    });
    assert.equal(msg2.statusCode, 200);

    const msgs = await ctx.app.inject({ method: 'GET', url: '/rooms/r1/messages' });
    const messages = msgs.json();
    const reply = messages.find((m: { id: number }) => m.id === msg2.json().id);
    assert.equal(reply.replyTo, parentId);
  });

  it('GET /rooms/:id/messages — returns messages in ascending order', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/rooms/r1/messages',
      payload: { content: 'first' }, headers: { 'x-agent-name': 'alice' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/rooms/r1/messages',
      payload: { content: 'second' }, headers: { 'x-agent-name': 'bob' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/rooms/r1/messages' });
    assert.equal(res.statusCode, 200);
    const messages = res.json();
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, 'first');
    assert.equal(messages[1].content, 'second');
  });

  it('GET /rooms/:id/messages?since=N returns messages after ID N', async () => {
    const m1 = await ctx.app.inject({
      method: 'POST', url: '/rooms/r1/messages',
      payload: { content: 'first' }, headers: { 'x-agent-name': 'alice' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/rooms/r1/messages',
      payload: { content: 'second' }, headers: { 'x-agent-name': 'bob' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/rooms/r1/messages',
      payload: { content: 'third' }, headers: { 'x-agent-name': 'alice' },
    });

    const sinceId = m1.json().id;
    const res = await ctx.app.inject({ method: 'GET', url: `/rooms/r1/messages?since=${sinceId}` });
    const messages = res.json();
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, 'second');
    assert.equal(messages[1].content, 'third');
  });

  it('GET /rooms/:id/messages?before=N returns messages before ID N', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/rooms/r1/messages',
      payload: { content: 'first' }, headers: { 'x-agent-name': 'alice' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/rooms/r1/messages',
      payload: { content: 'second' }, headers: { 'x-agent-name': 'bob' },
    });
    const m3 = await ctx.app.inject({
      method: 'POST', url: '/rooms/r1/messages',
      payload: { content: 'third' }, headers: { 'x-agent-name': 'alice' },
    });

    const beforeId = m3.json().id;
    const res = await ctx.app.inject({ method: 'GET', url: `/rooms/r1/messages?before=${beforeId}` });
    const messages = res.json();
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, 'first');
    assert.equal(messages[1].content, 'second');
  });

  it('GET /rooms/:id/messages — agent non-member gets 403', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/rooms/r1/messages',
      headers: { 'x-agent-name': 'eve' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('GET /rooms/:id/messages — no X-Agent-Name header: open read, 200', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/rooms/r1/messages' });
    assert.equal(res.statusCode, 200);
  });

  it('GET /rooms/:id/messages — 404 for unknown room', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/rooms/nonexistent/messages' });
    assert.equal(res.statusCode, 404);
  });

  it('GET /rooms/:id/messages — limit parameter works', async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.app.inject({
        method: 'POST', url: '/rooms/r1/messages',
        payload: { content: `msg-${i}` }, headers: { 'x-agent-name': 'alice' },
      });
    }

    const res = await ctx.app.inject({ method: 'GET', url: '/rooms/r1/messages?limit=2' });
    const messages = res.json();
    assert.equal(messages.length, 2);
    // Default mode returns last N messages (DESC then reversed), so we get the last 2
    assert.equal(messages[0].content, 'msg-3');
    assert.equal(messages[1].content, 'msg-4');
  });
});

/* ------------------------------------------------------------------ */
/*  Auto-direct-room on agent registration                             */
/* ------------------------------------------------------------------ */
describe('auto-direct-room on agent registration', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(agentsPlugin, { config: createTestConfig() });
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it('POST /agents/register creates {name}-direct room with type direct', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    // Verify room via direct DB query
    const roomRows = await ctx.db.select().from(rooms).where(eq(rooms.id, 'agent-1-direct'));
    assert.equal(roomRows.length, 1);
    assert.equal(roomRows[0].type, 'direct');
    assert.equal(roomRows[0].name, 'Direct: agent-1');
  });

  it('direct room has members [agent-name, "user"]', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    const memberRows = await ctx.db.select().from(roomMembers).where(eq(roomMembers.roomId, 'agent-1-direct'));
    const memberNames = memberRows.map(m => m.member).sort();
    assert.deepEqual(memberNames, ['agent-1', 'user']);
  });

  it('re-registering same agent does NOT duplicate the room', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt2' },
    });

    const roomRows = await ctx.db.select().from(rooms).where(eq(rooms.id, 'agent-1-direct'));
    assert.equal(roomRows.length, 1);
  });

  it('registration with containerHost stores it', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt1', containerHost: '172.17.0.2' },
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/agents/agent-1' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().containerHost, '172.17.0.2');
  });
});

/* ------------------------------------------------------------------ */
/*  Chat message broadcast (Phase 5b)                                  */
/* ------------------------------------------------------------------ */
describe('chat message broadcast', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(agentsPlugin, { config: createTestConfig() });
    await ctx.app.register(roomsPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it('message POST succeeds when member has no container_host', async () => {
    // Register agent without containerHost
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-1', worktree: '/tmp/wt1' },
    });

    // Create room with user and agent-1
    await ctx.app.inject({
      method: 'POST',
      url: '/rooms',
      payload: { id: 'r-bc1', name: 'Broadcast Test 1', type: 'group', members: ['agent-1'] },
      headers: { 'x-agent-name': 'user' },
    });

    // Post message as user — broadcast should skip agent-1 (no container_host)
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/rooms/r-bc1/messages',
      payload: { content: 'hello agent' },
      headers: { 'x-agent-name': 'user' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.id, 'number');
  });

  it('message POST succeeds when member has unreachable container_host', async () => {
    // Register agent WITH containerHost pointing to nothing listening on 8788
    await ctx.app.inject({
      method: 'POST',
      url: '/agents/register',
      payload: { name: 'agent-2', worktree: '/tmp/wt2', containerHost: '127.0.0.1' },
    });

    // Create room with user and agent-2
    await ctx.app.inject({
      method: 'POST',
      url: '/rooms',
      payload: { id: 'r-bc2', name: 'Broadcast Test 2', type: 'group', members: ['agent-2'] },
      headers: { 'x-agent-name': 'user' },
    });

    // Post message as user — broadcast fires fetch to 127.0.0.1:8788 which should fail silently
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/rooms/r-bc2/messages',
      payload: { content: 'hello unreachable' },
      headers: { 'x-agent-name': 'user' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.id, 'number');
  });

  it('message POST succeeds when member is unregistered (pending)', async () => {
    // Create room with a member that has no agent registration at all
    await ctx.app.inject({
      method: 'POST',
      url: '/rooms',
      payload: { id: 'r-bc3', name: 'Broadcast Test 3', type: 'group', members: ['ghost-agent'] },
      headers: { 'x-agent-name': 'user' },
    });

    // Post message as user — broadcast should see ghost-agent with NULL container_host and skip
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/rooms/r-bc3/messages',
      payload: { content: 'hello ghost' },
      headers: { 'x-agent-name': 'user' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.id, 'number');
  });
});
