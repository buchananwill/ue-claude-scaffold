import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestConfig } from "../test-helper.js";
import {
  createDrizzleTestApp,
  type DrizzleTestContext,
} from "../drizzle-test-helper.js";
import {
  rooms,
  roomMembers,
  agents as agentsTable,
  projects,
} from "../schema/tables.js";
import { eq } from "drizzle-orm";
import roomsPlugin from "./rooms.js";
import agentsPlugin from "./agents.js";

/** Register an agent via the route and return its id */
async function registerAgent(
  ctx: DrizzleTestContext,
  name: string,
  projectId: string = "default",
): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/agents/register",
    headers: { "x-project-id": projectId },
    payload: { name, worktree: `/tmp/wt-${name}` },
  });
  return res.json().id;
}

/** Ensure a project row exists. */
async function ensureProject(ctx: DrizzleTestContext, id: string) {
  await ctx.db
    .insert(projects)
    .values({ id, name: `Project ${id}` })
    .onConflictDoNothing();
}

/* ------------------------------------------------------------------ */
/*  Helper: create a room via inject                                   */
/* ------------------------------------------------------------------ */
async function createRoom(
  ctx: { app: import("fastify").FastifyInstance },
  opts: {
    id: string;
    name: string;
    type: string;
    members?: string[];
    agent?: string;
    projectId?: string;
  },
) {
  const headers: Record<string, string> = {};
  if (opts.agent) headers["x-agent-name"] = opts.agent;
  headers["x-project-id"] = opts.projectId ?? "default";
  return ctx.app.inject({
    method: "POST",
    url: "/rooms",
    payload: {
      id: opts.id,
      name: opts.name,
      type: opts.type,
      members: opts.members,
    },
    headers,
  });
}

/* ------------------------------------------------------------------ */
/*  Room CRUD                                                          */
/* ------------------------------------------------------------------ */
describe("rooms CRUD", () => {
  let ctx: DrizzleTestContext;
  let bobId: string;
  let carolId: string;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(agentsPlugin, { config: createTestConfig() });
    await ctx.app.register(roomsPlugin);
    // Register agents via the route (gives them proper UUIDs)
    await registerAgent(ctx, "alice");
    bobId = await registerAgent(ctx, "bob");
    carolId = await registerAgent(ctx, "carol");
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it("POST /rooms creates a room and returns {ok, id}", async () => {
    const res = await createRoom(ctx, {
      id: "r1",
      name: "Room 1",
      type: "group",
      agent: "alice",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.id, "r1");
  });

  it("POST /rooms — creator is auto-added to members", async () => {
    await createRoom(ctx, {
      id: "r1",
      name: "Room 1",
      type: "group",
      agent: "alice",
    });
    const detail = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r1",
      headers: { "x-project-id": "default" },
    });
    const members = detail
      .json()
      .members.map((m: { member: string }) => m.member);
    assert.ok(members.includes("alice"));
  });

  it("POST /rooms — members in body are added", async () => {
    await createRoom(ctx, {
      id: "r1",
      name: "Room 1",
      type: "group",
      agent: "alice",
      members: ["bob", "carol"],
    });
    const detail = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r1",
      headers: { "x-project-id": "default" },
    });
    const members = detail
      .json()
      .members.map((m: { member: string }) => m.member);
    assert.ok(members.includes("alice"));
    assert.ok(members.includes("bob"));
    assert.ok(members.includes("carol"));
  });

  it("POST /rooms — invalid id returns 400", async () => {
    const res = await createRoom(ctx, {
      id: "bad id!",
      name: "Test",
      type: "group",
    });
    assert.equal(res.statusCode, 400);
  });

  it("POST /rooms — name exceeding 256 characters returns 400", async () => {
    const res = await createRoom(ctx, {
      id: "r-long",
      name: "x".repeat(257),
      type: "group",
    });
    assert.equal(res.statusCode, 400);
  });

  it("POST /rooms — invalid type returns 400", async () => {
    const res = await createRoom(ctx, {
      id: "r1",
      name: "Bad",
      type: "invalid",
    });
    assert.equal(res.statusCode, 400);
  });

  it("GET /rooms returns all rooms with memberCount", async () => {
    await createRoom(ctx, {
      id: "r1",
      name: "Room 1",
      type: "group",
      agent: "alice",
      members: ["bob"],
    });
    await createRoom(ctx, {
      id: "r2",
      name: "Room 2",
      type: "direct",
      agent: "carol",
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/rooms",
      headers: { "x-project-id": "default" },
    });
    assert.equal(res.statusCode, 200);
    const roomsList = res.json();
    // Filter out auto-direct rooms created by agent registration
    const testRooms = roomsList.filter(
      (r: { id: string }) => r.id === "r1" || r.id === "r2",
    );
    assert.equal(testRooms.length, 2);

    const r1 = testRooms.find((r: { id: string }) => r.id === "r1");
    assert.equal(r1.memberCount, 2);

    const r2 = testRooms.find((r: { id: string }) => r.id === "r2");
    assert.equal(r2.memberCount, 1);
  });

  it("GET /rooms?member=X filters to rooms where X is a member", async () => {
    await createRoom(ctx, {
      id: "r1",
      name: "Room 1",
      type: "group",
      agent: "alice",
      members: ["bob"],
    });
    await createRoom(ctx, {
      id: "r2",
      name: "Room 2",
      type: "group",
      agent: "carol",
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/rooms?member=bob",
      headers: { "x-project-id": "default" },
    });
    const roomsList = res.json();
    // bob is member of r1 only (not auto-direct rooms for other agents)
    assert.ok(roomsList.some((r: { id: string }) => r.id === "r1"));
    assert.ok(!roomsList.some((r: { id: string }) => r.id === "r2"));
  });

  it("GET /rooms/:id returns room detail with members array", async () => {
    await createRoom(ctx, {
      id: "r1",
      name: "Room 1",
      type: "group",
      agent: "alice",
    });
    const res = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r1",
      headers: { "x-project-id": "default" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.id, "r1");
    assert.equal(body.name, "Room 1");
    assert.equal(body.type, "group");
    assert.ok(Array.isArray(body.members));
    assert.equal(body.members.length, 1);
    assert.equal(body.members[0].member, "alice");
    assert.ok(body.members[0].joinedAt);
  });

  it("GET /rooms/:id returns 404 for unknown room", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/rooms/nonexistent",
      headers: { "x-project-id": "default" },
    });
    assert.equal(res.statusCode, 404);
  });

  it("DELETE /rooms/:id deletes room; subsequent GET returns 404", async () => {
    await createRoom(ctx, {
      id: "r1",
      name: "Room 1",
      type: "group",
      agent: "alice",
    });
    const del = await ctx.app.inject({
      method: "DELETE",
      url: "/rooms/r1",
      headers: { "x-project-id": "default" },
    });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().ok, true);

    const get = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r1",
      headers: { "x-project-id": "default" },
    });
    assert.equal(get.statusCode, 404);
  });

  it("DELETE /rooms/:id cascade deletes messages", async () => {
    await createRoom(ctx, {
      id: "r1",
      name: "Room 1",
      type: "group",
      agent: "alice",
    });
    await ctx.app.inject({
      method: "POST",
      url: "/rooms/r1/messages",
      payload: { content: "hello" },
      headers: { "x-agent-name": "alice", "x-project-id": "default" },
    });

    await ctx.app.inject({
      method: "DELETE",
      url: "/rooms/r1",
      headers: { "x-project-id": "default" },
    });

    await createRoom(ctx, {
      id: "r1",
      name: "Room 1 v2",
      type: "group",
      agent: "alice",
    });
    const msgs = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r1/messages",
      headers: { "x-project-id": "default" },
    });
    assert.equal(msgs.statusCode, 200);
    assert.equal(msgs.json().length, 0);
  });

  it("POST /rooms/:id/members adds members", async () => {
    await createRoom(ctx, {
      id: "r1",
      name: "Room 1",
      type: "group",
      agent: "alice",
    });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/rooms/r1/members",
      headers: { "x-project-id": "default" },
      payload: { agentIds: [bobId, carolId] },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);

    const detail = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r1",
      headers: { "x-project-id": "default" },
    });
    const members = detail
      .json()
      .members.map((m: { member: string }) => m.member);
    assert.equal(members.length, 3);
    assert.ok(members.includes("bob"));
    assert.ok(members.includes("carol"));
  });

  it("POST /rooms/:id/members returns 404 for unknown room", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/rooms/nonexistent/members",
      headers: { "x-project-id": "default" },
      payload: { agentIds: [bobId] },
    });
    assert.equal(res.statusCode, 404);
  });

  it("GET /rooms/:id returns 404 for room in different project", async () => {
    await createRoom(ctx, {
      id: "r-proj",
      name: "Project Room",
      type: "group",
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r-proj",
      headers: { "x-project-id": "other-project" },
    });
    assert.equal(res.statusCode, 404);
  });

  it("DELETE /rooms/:id/members/:member removes a member", async () => {
    await createRoom(ctx, {
      id: "r1",
      name: "Room 1",
      type: "group",
      agent: "alice",
      members: ["bob"],
    });
    const res = await ctx.app.inject({
      method: "DELETE",
      url: "/rooms/r1/members/bob",
      headers: { "x-project-id": "default" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);

    const detail = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r1",
      headers: { "x-project-id": "default" },
    });
    const members = detail
      .json()
      .members.map((m: { member: string }) => m.member);
    assert.ok(!members.includes("bob"));
    assert.ok(members.includes("alice"));
  });
});

/* ------------------------------------------------------------------ */
/*  Chat messages                                                      */
/* ------------------------------------------------------------------ */
describe("chat messages", () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(agentsPlugin, { config: createTestConfig() });
    await ctx.app.register(roomsPlugin);
    // Register agents via routes
    await registerAgent(ctx, "alice");
    await registerAgent(ctx, "bob");
    await registerAgent(ctx, "eve");
    // Create a room with alice and bob as members
    await ctx.app.inject({
      method: "POST",
      url: "/rooms",
      payload: { id: "r1", name: "Test Room", type: "group", members: ["bob"] },
      headers: { "x-agent-name": "alice", "x-project-id": "default" },
    });
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it("POST /rooms/:id/messages — member posts message, returns {ok, id}", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/rooms/r1/messages",
      payload: { content: "hello world" },
      headers: { "x-agent-name": "alice", "x-project-id": "default" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.id, "number");
  });

  it("POST /rooms/:id/messages — non-member gets 403", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/rooms/r1/messages",
      payload: { content: "intruder" },
      headers: { "x-agent-name": "eve", "x-project-id": "default" },
    });
    assert.equal(res.statusCode, 403);
  });

  it("POST /rooms/:id/messages — no header: operator flow, 200 (implicit access)", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/rooms/r1/messages",
      payload: { content: "hi from operator" },
      headers: { "x-project-id": "default" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
  });

  it("POST /rooms/:id/messages — 404 for unknown room", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/rooms/nonexistent/messages",
      payload: { content: "hello" },
      headers: { "x-agent-name": "alice", "x-project-id": "default" },
    });
    assert.equal(res.statusCode, 404);
  });

  it("POST /rooms/:id/messages — replyTo field works", async () => {
    const msg1 = await ctx.app.inject({
      method: "POST",
      url: "/rooms/r1/messages",
      payload: { content: "original" },
      headers: { "x-agent-name": "alice", "x-project-id": "default" },
    });
    const parentId = msg1.json().id;

    const msg2 = await ctx.app.inject({
      method: "POST",
      url: "/rooms/r1/messages",
      payload: { content: "reply", replyTo: parentId },
      headers: { "x-agent-name": "bob", "x-project-id": "default" },
    });
    assert.equal(msg2.statusCode, 200);

    const msgs = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r1/messages",
      headers: { "x-project-id": "default" },
    });
    const messages = msgs.json();
    const reply = messages.find((m: { id: number }) => m.id === msg2.json().id);
    assert.equal(reply.replyTo, parentId);
  });

  it("GET /rooms/:id/messages — returns messages in ascending order", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/rooms/r1/messages",
      payload: { content: "first" },
      headers: { "x-agent-name": "alice", "x-project-id": "default" },
    });
    await ctx.app.inject({
      method: "POST",
      url: "/rooms/r1/messages",
      payload: { content: "second" },
      headers: { "x-agent-name": "bob", "x-project-id": "default" },
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r1/messages",
      headers: { "x-project-id": "default" },
    });
    assert.equal(res.statusCode, 200);
    const messages = res.json();
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, "first");
    assert.equal(messages[1].content, "second");
  });

  it("GET /rooms/:id/messages?since=N returns messages after ID N", async () => {
    const m1 = await ctx.app.inject({
      method: "POST",
      url: "/rooms/r1/messages",
      payload: { content: "first" },
      headers: { "x-agent-name": "alice", "x-project-id": "default" },
    });
    await ctx.app.inject({
      method: "POST",
      url: "/rooms/r1/messages",
      payload: { content: "second" },
      headers: { "x-agent-name": "bob", "x-project-id": "default" },
    });
    await ctx.app.inject({
      method: "POST",
      url: "/rooms/r1/messages",
      payload: { content: "third" },
      headers: { "x-agent-name": "alice", "x-project-id": "default" },
    });

    const sinceId = m1.json().id;
    const res = await ctx.app.inject({
      method: "GET",
      url: `/rooms/r1/messages?since=${sinceId}`,
      headers: { "x-project-id": "default" },
    });
    const messages = res.json();
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, "second");
    assert.equal(messages[1].content, "third");
  });

  it("GET /rooms/:id/messages?before=N returns messages before ID N", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/rooms/r1/messages",
      payload: { content: "first" },
      headers: { "x-agent-name": "alice", "x-project-id": "default" },
    });
    await ctx.app.inject({
      method: "POST",
      url: "/rooms/r1/messages",
      payload: { content: "second" },
      headers: { "x-agent-name": "bob", "x-project-id": "default" },
    });
    const m3 = await ctx.app.inject({
      method: "POST",
      url: "/rooms/r1/messages",
      payload: { content: "third" },
      headers: { "x-agent-name": "alice", "x-project-id": "default" },
    });

    const beforeId = m3.json().id;
    const res = await ctx.app.inject({
      method: "GET",
      url: `/rooms/r1/messages?before=${beforeId}`,
      headers: { "x-project-id": "default" },
    });
    const messages = res.json();
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, "first");
    assert.equal(messages[1].content, "second");
  });

  it("GET /rooms/:id/messages — agent non-member gets 403", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r1/messages",
      headers: { "x-agent-name": "eve", "x-project-id": "default" },
    });
    assert.equal(res.statusCode, 403);
  });

  it("GET /rooms/:id/messages — no X-Agent-Name header: open read, 200", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r1/messages",
      headers: { "x-project-id": "default" },
    });
    assert.equal(res.statusCode, 200);
  });

  it("GET /rooms/:id/messages — 404 for unknown room", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/rooms/nonexistent/messages",
      headers: { "x-project-id": "default" },
    });
    assert.equal(res.statusCode, 404);
  });

  it("GET /rooms/:id/messages?since=abc returns 400", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r1/messages?since=abc",
      headers: { "x-project-id": "default" },
    });
    assert.equal(res.statusCode, 400);
  });

  it("GET /rooms/:id/messages?before=-1 returns 400", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r1/messages?before=-1",
      headers: { "x-project-id": "default" },
    });
    assert.equal(res.statusCode, 400);
  });

  it("GET /rooms/:id/messages — limit parameter works", async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.app.inject({
        method: "POST",
        url: "/rooms/r1/messages",
        payload: { content: `msg-${i}` },
        headers: { "x-agent-name": "alice", "x-project-id": "default" },
      });
    }

    const res = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r1/messages?limit=2",
      headers: { "x-project-id": "default" },
    });
    const messages = res.json();
    assert.equal(messages.length, 2);
    // Default mode returns last N messages (DESC then reversed), so we get the last 2
    assert.equal(messages[0].content, "msg-3");
    assert.equal(messages[1].content, "msg-4");
  });
});

/* ------------------------------------------------------------------ */
/*  Auto-direct-room on agent registration                             */
/* ------------------------------------------------------------------ */
describe("auto-direct-room on agent registration", () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(agentsPlugin, { config: createTestConfig() });
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it("POST /agents/register creates {name}-direct room with type direct", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/agents/register",
      headers: { "x-project-id": "default" },
      payload: { name: "agent-1", worktree: "/tmp/wt1" },
    });

    const roomRows = await ctx.db
      .select()
      .from(rooms)
      .where(eq(rooms.id, "agent-1-direct"));
    assert.equal(roomRows.length, 1);
    assert.equal(roomRows[0].type, "direct");
    assert.equal(roomRows[0].name, "Direct: agent-1");
  });

  it("direct room has the agent as a member", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/agents/register",
      headers: { "x-project-id": "default" },
      payload: { name: "agent-1", worktree: "/tmp/wt1" },
    });

    const memberRows = await ctx.db
      .select({ name: agentsTable.name })
      .from(roomMembers)
      .innerJoin(agentsTable, eq(agentsTable.id, roomMembers.agentId))
      .where(eq(roomMembers.roomId, "agent-1-direct"));
    const memberNames = memberRows.map((m) => m.name).sort();
    assert.deepEqual(memberNames, ["agent-1"]);
  });

  it("re-registering same agent does NOT duplicate the room", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/agents/register",
      headers: { "x-project-id": "default" },
      payload: { name: "agent-1", worktree: "/tmp/wt1" },
    });
    await ctx.app.inject({
      method: "POST",
      url: "/agents/register",
      headers: { "x-project-id": "default" },
      payload: { name: "agent-1", worktree: "/tmp/wt2" },
    });

    const roomRows = await ctx.db
      .select()
      .from(rooms)
      .where(eq(rooms.id, "agent-1-direct"));
    assert.equal(roomRows.length, 1);
  });

  it("registration with containerHost stores it", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/agents/register",
      headers: { "x-project-id": "default" },
      payload: {
        name: "agent-1",
        worktree: "/tmp/wt1",
        containerHost: "172.17.0.2",
      },
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/agents/agent-1",
      headers: { "x-project-id": "default" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().containerHost, "172.17.0.2");
  });
});

/* ------------------------------------------------------------------ */
/*  Chat message broadcast (Phase 5b)                                  */
/* ------------------------------------------------------------------ */
describe("chat message broadcast", () => {
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

  it("message POST succeeds when member has no container_host", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/agents/register",
      headers: { "x-project-id": "default" },
      payload: { name: "agent-1", worktree: "/tmp/wt1" },
    });

    await ctx.app.inject({
      method: "POST",
      url: "/rooms",
      headers: { "x-project-id": "default" },
      payload: {
        id: "r-bc1",
        name: "Broadcast Test 1",
        type: "group",
        members: ["agent-1"],
      },
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/rooms/r-bc1/messages",
      payload: { content: "hello agent" },
      headers: { "x-project-id": "default" },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.id, "number");
  });

  it("message POST succeeds when member has unreachable container_host", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/agents/register",
      headers: { "x-project-id": "default" },
      payload: {
        name: "agent-2",
        worktree: "/tmp/wt2",
        containerHost: "127.0.0.1",
      },
    });

    await ctx.app.inject({
      method: "POST",
      url: "/rooms",
      headers: { "x-project-id": "default" },
      payload: {
        id: "r-bc2",
        name: "Broadcast Test 2",
        type: "group",
        members: ["agent-2"],
      },
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/rooms/r-bc2/messages",
      payload: { content: "hello unreachable" },
      headers: { "x-project-id": "default" },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.id, "number");
  });

  it("message POST succeeds when member is unregistered (pending)", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/agents/register",
      headers: { "x-project-id": "default" },
      payload: { name: "ghost-agent", worktree: "/tmp/wt-ghost" },
    });

    await ctx.app.inject({
      method: "POST",
      url: "/rooms",
      headers: { "x-project-id": "default" },
      payload: {
        id: "r-bc3",
        name: "Broadcast Test 3",
        type: "group",
        members: ["ghost-agent"],
      },
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/rooms/r-bc3/messages",
      payload: { content: "hello ghost" },
      headers: { "x-project-id": "default" },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.id, "number");
  });
});

/* ------------------------------------------------------------------ */
/*  Option D agent/operator authorship                                 */
/* ------------------------------------------------------------------ */
describe("Option D agent/operator authorship", () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(agentsPlugin, { config: createTestConfig() });
    await ctx.app.register(roomsPlugin);
    await ensureProject(ctx, "alpha");
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it("agent-authored message, is member", async () => {
    await registerAgent(ctx, "agent-1", "alpha");

    // Create a direct room for agent-1
    await ctx.app.inject({
      method: "POST",
      url: "/rooms",
      headers: { "x-agent-name": "agent-1", "x-project-id": "alpha" },
      payload: { id: "r-opt-d", name: "Option D Room", type: "group" },
    });

    // POST message as agent-1
    const postRes = await ctx.app.inject({
      method: "POST",
      url: "/rooms/r-opt-d/messages",
      headers: { "x-agent-name": "agent-1", "x-project-id": "alpha" },
      payload: { content: "hello from agent" },
    });
    assert.equal(postRes.statusCode, 200);

    // GET messages and verify sender
    const getRes = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r-opt-d/messages",
      headers: { "x-project-id": "alpha" },
    });
    assert.equal(getRes.statusCode, 200);
    const messages = getRes.json();
    assert.ok(messages.length >= 1);
    const msg = messages.find(
      (m: { content: string }) => m.content === "hello from agent",
    );
    assert.ok(msg);
    assert.equal(msg.sender, "agent-1");
  });

  it("agent-authored message, not member returns 403", async () => {
    await registerAgent(ctx, "agent-1", "alpha");

    // Create a room WITHOUT adding agent-1 as a member (operator creates)
    await ctx.app.inject({
      method: "POST",
      url: "/rooms",
      headers: { "x-project-id": "alpha" },
      payload: { id: "r-noaccess", name: "No Access", type: "group" },
    });

    // POST with agent-1 header
    const res = await ctx.app.inject({
      method: "POST",
      url: "/rooms/r-noaccess/messages",
      headers: { "x-agent-name": "agent-1", "x-project-id": "alpha" },
      payload: { content: "blocked" },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "not_a_member");
  });

  it("operator-authored message stores author_type=operator, sender=user", async () => {
    // Create a room as operator
    await ctx.app.inject({
      method: "POST",
      url: "/rooms",
      headers: { "x-project-id": "alpha" },
      payload: { id: "r-op", name: "Op Room", type: "group" },
    });

    // POST without X-Agent-Name
    const postRes = await ctx.app.inject({
      method: "POST",
      url: "/rooms/r-op/messages",
      headers: { "x-project-id": "alpha" },
      payload: { content: "operator message" },
    });
    assert.equal(postRes.statusCode, 200);

    // GET messages
    const getRes = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r-op/messages",
      headers: { "x-project-id": "alpha" },
    });
    const messages = getRes.json();
    const opMsg = messages.find(
      (m: { content: string }) => m.content === "operator message",
    );
    assert.ok(opMsg);
    assert.equal(opMsg.sender, "user");
  });

  it("GET with agent header, not member returns 403", async () => {
    await registerAgent(ctx, "agent-1", "alpha");

    await ctx.app.inject({
      method: "POST",
      url: "/rooms",
      headers: { "x-project-id": "alpha" },
      payload: { id: "r-read-block", name: "Read Block", type: "group" },
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r-read-block/messages",
      headers: { "x-agent-name": "agent-1", "x-project-id": "alpha" },
    });
    assert.equal(res.statusCode, 403);
  });

  it("GET without agent header (operator read) returns 200", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/rooms",
      headers: { "x-project-id": "alpha" },
      payload: { id: "r-op-read", name: "Op Read", type: "group" },
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/rooms/r-op-read/messages",
      headers: { "x-project-id": "alpha" },
    });
    assert.equal(res.statusCode, 200);
  });

  it("unknown agent header returns 403 unknown_agent", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/rooms",
      headers: { "x-project-id": "alpha" },
      payload: { id: "r-ghost", name: "Ghost Room", type: "group" },
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/rooms/r-ghost/messages",
      headers: { "x-agent-name": "ghost", "x-project-id": "alpha" },
      payload: { content: "boo" },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "unknown_agent");
  });
});
