import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import roomsPlugin from './rooms.js';
import teamsPlugin from './teams.js';

/* ------------------------------------------------------------------ */
/*  Helper: create a team via inject                                   */
/* ------------------------------------------------------------------ */
async function createTeam(
  ctx: { app: import('fastify').FastifyInstance },
  opts: {
    id: string;
    name: string;
    briefPath?: string;
    members: Array<{ agentName: string; role: string; isLeader?: boolean }>;
    agent?: string;
  },
) {
  const headers: Record<string, string> = {};
  if (opts.agent) headers['x-agent-name'] = opts.agent;
  return ctx.app.inject({
    method: 'POST',
    url: '/teams',
    payload: {
      id: opts.id,
      name: opts.name,
      briefPath: opts.briefPath,
      members: opts.members,
    },
    headers,
  });
}

/* ------------------------------------------------------------------ */
/*  POST /teams — create team                                          */
/* ------------------------------------------------------------------ */
describe('POST /teams', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(roomsPlugin);
    await ctx.app.register(teamsPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it('creates a team and returns {ok, id, roomId}', async () => {
    const res = await createTeam(ctx, {
      id: 'team-1',
      name: 'Alpha Team',
      members: [
        { agentName: 'alice', role: 'implementer', isLeader: true },
        { agentName: 'bob', role: 'reviewer' },
      ],
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.id, 'team-1');
    assert.equal(body.roomId, 'team-1');
  });

  it('auto-creates a group room with team ID as room ID', async () => {
    await createTeam(ctx, {
      id: 'team-2',
      name: 'Beta Team',
      members: [{ agentName: 'alice', role: 'lead', isLeader: true }],
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/rooms/team-2' });
    assert.equal(res.statusCode, 200);
    const room = res.json();
    assert.equal(room.id, 'team-2');
    assert.equal(room.type, 'group');
  });

  it('room contains all members plus "user"', async () => {
    await createTeam(ctx, {
      id: 'team-3',
      name: 'Gamma Team',
      members: [
        { agentName: 'alice', role: 'implementer', isLeader: true },
        { agentName: 'bob', role: 'reviewer' },
      ],
      agent: 'orchestrator',
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/rooms/team-3' });
    const members = res.json().members.map((m: { member: string }) => m.member).sort();
    assert.deepEqual(members, ['alice', 'bob', 'user']);
  });

  it('returns 400 when zero leaders provided', async () => {
    const res = await createTeam(ctx, {
      id: 'team-bad',
      name: 'No Chair',
      members: [
        { agentName: 'alice', role: 'implementer' },
        { agentName: 'bob', role: 'reviewer' },
      ],
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 when two leaders provided', async () => {
    const res = await createTeam(ctx, {
      id: 'team-bad2',
      name: 'Two Chairs',
      members: [
        { agentName: 'alice', role: 'implementer', isLeader: true },
        { agentName: 'bob', role: 'reviewer', isLeader: true },
      ],
    });
    assert.equal(res.statusCode, 400);
  });
});

/* ------------------------------------------------------------------ */
/*  GET /teams — list teams                                            */
/* ------------------------------------------------------------------ */
describe('GET /teams', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(roomsPlugin);
    await ctx.app.register(teamsPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it('returns all teams', async () => {
    await createTeam(ctx, {
      id: 't1', name: 'Team 1',
      members: [{ agentName: 'a', role: 'r', isLeader: true }],
    });
    await createTeam(ctx, {
      id: 't2', name: 'Team 2',
      members: [{ agentName: 'b', role: 'r', isLeader: true }],
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/teams' });
    assert.equal(res.statusCode, 200);
    const teams = res.json();
    assert.equal(teams.length, 2);
  });

  it('filters by ?status=active', async () => {
    await createTeam(ctx, {
      id: 't1', name: 'Active',
      members: [{ agentName: 'a', role: 'r', isLeader: true }],
    });
    await createTeam(ctx, {
      id: 't2', name: 'Will Dissolve',
      members: [{ agentName: 'b', role: 'r', isLeader: true }],
    });
    // Dissolve t2
    await ctx.app.inject({ method: 'DELETE', url: '/teams/t2' });

    const res = await ctx.app.inject({ method: 'GET', url: '/teams?status=active' });
    const teams = res.json();
    assert.equal(teams.length, 1);
    assert.equal(teams[0].id, 't1');
    assert.equal(teams[0].status, 'active');
  });
});

/* ------------------------------------------------------------------ */
/*  GET /teams/:id — team detail                                       */
/* ------------------------------------------------------------------ */
describe('GET /teams/:id', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(roomsPlugin);
    await ctx.app.register(teamsPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it('returns detail with members array, roomId, status', async () => {
    await createTeam(ctx, {
      id: 'td1',
      name: 'Detail Team',
      briefPath: '/plans/brief.md',
      members: [
        { agentName: 'alice', role: 'implementer', isLeader: true },
        { agentName: 'bob', role: 'reviewer' },
      ],
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/teams/td1' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.id, 'td1');
    assert.equal(body.name, 'Detail Team');
    assert.equal(body.briefPath, '/plans/brief.md');
    assert.equal(body.status, 'active');
    assert.equal(body.roomId, 'td1');
    assert.ok(Array.isArray(body.members));
    assert.equal(body.members.length, 2);

    const leader = body.members.find((m: { agentName: string }) => m.agentName === 'alice');
    assert.equal(leader.role, 'implementer');
    assert.equal(leader.isLeader, true);

    const member = body.members.find((m: { agentName: string }) => m.agentName === 'bob');
    assert.equal(member.role, 'reviewer');
    assert.equal(member.isLeader, false);
  });

  it('returns 404 for unknown team', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/teams/nonexistent' });
    assert.equal(res.statusCode, 404);
  });
});

/* ------------------------------------------------------------------ */
/*  DELETE /teams/:id — dissolve team                                  */
/* ------------------------------------------------------------------ */
describe('DELETE /teams/:id', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(roomsPlugin);
    await ctx.app.register(teamsPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it('sets status to dissolved and dissolved_at', async () => {
    await createTeam(ctx, {
      id: 'del1', name: 'To Dissolve',
      members: [{ agentName: 'a', role: 'r', isLeader: true }],
    });

    const del = await ctx.app.inject({ method: 'DELETE', url: '/teams/del1' });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().ok, true);

    const detail = await ctx.app.inject({ method: 'GET', url: '/teams/del1' });
    const body = detail.json();
    assert.equal(body.status, 'dissolved');
    assert.ok(body.dissolvedAt);
  });

  it('returns 404 for unknown team', async () => {
    const res = await ctx.app.inject({ method: 'DELETE', url: '/teams/nonexistent' });
    assert.equal(res.statusCode, 404);
  });

  it('room still exists after dissolve', async () => {
    await createTeam(ctx, {
      id: 'del2', name: 'Dissolve With Room',
      members: [{ agentName: 'a', role: 'r', isLeader: true }],
    });

    await ctx.app.inject({ method: 'DELETE', url: '/teams/del2' });

    const room = await ctx.app.inject({ method: 'GET', url: '/rooms/del2' });
    assert.equal(room.statusCode, 200);
    assert.equal(room.json().id, 'del2');
  });
});

/* ------------------------------------------------------------------ */
/*  PATCH /teams/:id — update team                                     */
/* ------------------------------------------------------------------ */
describe('PATCH /teams/:id', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(roomsPlugin);
    await ctx.app.register(teamsPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it('updates status to converging', async () => {
    await createTeam(ctx, {
      id: 'p1', name: 'Patch Team',
      members: [{ agentName: 'a', role: 'r', isLeader: true }],
    });

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/teams/p1',
      payload: { status: 'converging' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);

    const detail = await ctx.app.inject({ method: 'GET', url: '/teams/p1' });
    assert.equal(detail.json().status, 'converging');
  });

  it('sets deliverable text', async () => {
    await createTeam(ctx, {
      id: 'p2', name: 'Deliverable Team',
      members: [{ agentName: 'a', role: 'r', isLeader: true }],
    });

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/teams/p2',
      payload: { deliverable: 'Final report v1' },
    });
    assert.equal(res.statusCode, 200);

    const detail = await ctx.app.inject({ method: 'GET', url: '/teams/p2' });
    assert.equal(detail.json().deliverable, 'Final report v1');
  });

  it('returns 400 for invalid status value', async () => {
    await createTeam(ctx, {
      id: 'p3', name: 'Bad Status',
      members: [{ agentName: 'a', role: 'r', isLeader: true }],
    });

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/teams/p3',
      payload: { status: 'bogus' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 404 for unknown team', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/teams/nonexistent',
      payload: { status: 'converging' },
    });
    assert.equal(res.statusCode, 404);
  });
});
