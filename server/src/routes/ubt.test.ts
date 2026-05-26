import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import {
  createDrizzleTestApp,
  type DrizzleTestContext,
} from "../drizzle-test-helper.js";
import { createTestConfig, registerAgent } from "../test-helper.js";
import { registerBuild, unregisterBuild } from "../build-registry.js";
import agentsPlugin from "./agents.js";
import ubtPlugin, { sweepStaleLock } from "./ubt.js";

/** A stand-in child reporting as alive without spawning a real process. */
function fakeLiveChild(): ChildProcess {
  return { exitCode: null, killed: false } as unknown as ChildProcess;
}

describe("ubt routes (drizzle)", () => {
  let ctx: DrizzleTestContext;
  const config = createTestConfig();
  /** Agent UUID cache, populated by registerAgent. */
  let agentIds: Record<string, string>;

  beforeEach(async () => {
    agentIds = {};
    ctx = await createDrizzleTestApp();
    await ctx.app.register(agentsPlugin, { config });
    await ctx.app.register(ubtPlugin, { config });
    // Pre-register agents used across most UBT tests
    agentIds["agent-1"] = await registerAgent(ctx.app, "agent-1");
    agentIds["agent-2"] = await registerAgent(ctx.app, "agent-2");
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it("GET /ubt/status returns empty state initially", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/ubt/status" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.holder, null);
    assert.equal(body.acquiredAt, null);
    assert.deepEqual(body.queue, []);
  });

  it("POST /ubt/acquire when free grants the lock", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-1" },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { granted: true });
  });

  it("POST /ubt/acquire when held by same agent returns granted true", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-1" },
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-1" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().granted, true);
  });

  it("POST /ubt/acquire when held by other returns granted false with position and backoff", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-1" },
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-2" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.granted, false);
    assert.equal(typeof body.position, "number");
    assert.equal(typeof body.backoffMs, "number");
    assert.ok(body.position >= 1);
  });

  it("POST /ubt/acquire duplicate queue entry returns existing position", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-1" },
    });

    // First enqueue
    const r1 = await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-2" },
    });
    const pos1 = r1.json().position;

    // Second attempt - should return existing position, not re-enqueue
    const r2 = await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-2" },
    });
    const body2 = r2.json();
    assert.equal(body2.granted, false);
    assert.equal(body2.position, pos1);
  });

  it("POST /ubt/release clears lock", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-1" },
    });

    const rel = await ctx.app.inject({
      method: "POST",
      url: "/ubt/release",
      payload: { agent: "agent-1" },
    });
    assert.equal(rel.statusCode, 200);
    assert.equal(rel.json().ok, true);

    // Verify lock is cleared
    const status = await ctx.app.inject({ method: "GET", url: "/ubt/status" });
    assert.equal(status.json().holder, null);
  });

  it("POST /ubt/release promotes next from queue", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-1" },
    });
    // agent-2 enqueues
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-2" },
    });

    const rel = await ctx.app.inject({
      method: "POST",
      url: "/ubt/release",
      payload: { agent: "agent-1" },
    });
    assert.equal(rel.json().ok, true);
    // promoted is now a UUID
    assert.equal(rel.json().promoted, agentIds["agent-2"]);

    // Verify agent-2 now holds the lock (holder is UUID)
    const status = await ctx.app.inject({ method: "GET", url: "/ubt/status" });
    assert.equal(status.json().holder, agentIds["agent-2"]);
  });

  it("POST /ubt/acquire when held by other includes holder, holderSince, and estimatedWaitMs", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-1" },
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-2" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.granted, false);
    // holder is now the UUID of agent-1
    assert.equal(body.holder, agentIds["agent-1"]);
    assert.ok(body.holderSince != null);
    assert.equal(typeof body.estimatedWaitMs, "number");
    assert.ok(body.estimatedWaitMs > 0);
  });

  it("GET /ubt/status includes estimatedWaitMs", async () => {
    // When no holder, estimatedWaitMs should be 0
    const emptyRes = await ctx.app.inject({
      method: "GET",
      url: "/ubt/status",
    });
    assert.equal(emptyRes.json().estimatedWaitMs, 0);

    // When a holder exists, estimatedWaitMs should be > 0
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-1" },
    });
    const heldRes = await ctx.app.inject({ method: "GET", url: "/ubt/status" });
    const heldBody = heldRes.json();
    assert.equal(typeof heldBody.estimatedWaitMs, "number");
    assert.ok(heldBody.estimatedWaitMs > 0);
  });

  it("POST /ubt/release when no lock held returns not_held", async () => {
    const rel = await ctx.app.inject({
      method: "POST",
      url: "/ubt/release",
      payload: { agent: "agent-1" },
    });
    assert.equal(rel.statusCode, 200);
    assert.equal(rel.json().ok, false);
    assert.equal(rel.json().reason, "not_held");
  });

  it("sweepStaleLock does NOT clear lock held by registered agent", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-1" },
    });

    await sweepStaleLock();

    const status = await ctx.app.inject({ method: "GET", url: "/ubt/status" });
    assert.equal(status.json().holder, agentIds["agent-1"]);
  });

  it("sweepStaleLock clears lock held by deregistered agent", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-1" },
    });
    await ctx.app.inject({
      method: "DELETE",
      url: "/agents/agent-1",
    });

    await sweepStaleLock();

    const status = await ctx.app.inject({ method: "GET", url: "/ubt/status" });
    assert.equal(status.json().holder, null);
  });

  it("POST /ubt/acquire returns 404 for unregistered agent", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "ghost-agent" },
    });
    assert.equal(res.statusCode, 404);
  });

  it("sweepStaleLock promotes queued agent when holder is deregistered", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-1" },
    });
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-2" },
    });
    await ctx.app.inject({
      method: "DELETE",
      url: "/agents/agent-1",
    });

    await sweepStaleLock();

    const status = await ctx.app.inject({ method: "GET", url: "/ubt/status" });
    assert.equal(status.json().holder, agentIds["agent-2"]);
  });

  it("sweepStaleLock clears lock held by agent in stopping status", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-1" },
    });

    // Set agent to stopping status
    await ctx.app.inject({
      method: "POST",
      url: "/agents/agent-1/status",
      payload: { status: "stopping" },
    });

    await sweepStaleLock();

    const status = await ctx.app.inject({ method: "GET", url: "/ubt/status" });
    assert.equal(status.json().holder, null);
  });

  it("sweepStaleLock promotes queued agent when holder goes to stopping", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-1" },
    });
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-2" },
    });

    await ctx.app.inject({
      method: "POST",
      url: "/agents/agent-1/status",
      payload: { status: "stopping" },
    });

    await sweepStaleLock();

    const status = await ctx.app.inject({ method: "GET", url: "/ubt/status" });
    assert.equal(status.json().holder, agentIds["agent-2"]);
  });

  it("sweepStaleLock holds the lock while a build is live, even if the holder deregisters", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-1" },
    });
    // Holder goes away — but a build is genuinely running on the host.
    await ctx.app.inject({ method: "DELETE", url: "/agents/agent-1" });
    registerBuild(9001, fakeLiveChild());

    try {
      await sweepStaleLock();
      // Liveness beats the registration check: lock must NOT be swept.
      const status = await ctx.app.inject({
        method: "GET",
        url: "/ubt/status",
      });
      assert.equal(status.json().holder, agentIds["agent-1"]);
    } finally {
      unregisterBuild(9001);
    }

    // Once the build is gone, the next sweep frees the orphaned lock.
    await sweepStaleLock();
    const after = await ctx.app.inject({ method: "GET", url: "/ubt/status" });
    assert.equal(after.json().holder, null);
  });

  it("POST /ubt/kill clears the lock and reports no pids when nothing is tracked", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-1" },
    });

    const res = await ctx.app.inject({ method: "POST", url: "/ubt/kill" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.killedPids, []);

    const status = await ctx.app.inject({ method: "GET", url: "/ubt/status" });
    assert.equal(status.json().holder, null);
  });

  it("POST /ubt/kill promotes the next queued agent after freeing the lock", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-1" },
    });
    await ctx.app.inject({
      method: "POST",
      url: "/ubt/acquire",
      payload: { agent: "agent-2" },
    });

    const res = await ctx.app.inject({ method: "POST", url: "/ubt/kill" });
    assert.equal(res.json().promoted, agentIds["agent-2"]);

    const status = await ctx.app.inject({ method: "GET", url: "/ubt/status" });
    assert.equal(status.json().holder, agentIds["agent-2"]);
  });
});
