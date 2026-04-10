import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createDrizzleTestApp,
  type DrizzleTestContext,
} from "../drizzle-test-helper.js";
import hooksPlugin from "./hooks.js";

describe("POST /hooks/resolve", () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(hooksPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it("valid body returns 200 with correct resolved hooks", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/hooks/resolve",
      payload: { hasBuildScript: true },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.buildIntercept, true);
    assert.equal(body.cppLint, false);
    assert.equal(body.jsLint, false);
  });

  it("missing hasBuildScript returns 400", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/hooks/resolve",
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it("hasBuildScript as string returns 400", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/hooks/resolve",
      payload: { hasBuildScript: "true" },
    });
    assert.equal(res.statusCode, 400);
  });

  it("projectHooks.buildIntercept as string returns 400", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/hooks/resolve",
      payload: {
        hasBuildScript: true,
        projectHooks: { buildIntercept: "true" },
      },
    });
    assert.equal(res.statusCode, 400);
  });

  it("empty body returns 400", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/hooks/resolve",
      headers: { "content-type": "application/json" },
      payload: "",
    });
    assert.equal(res.statusCode, 400);
  });

  it("valid cascade with all levels set, CLI wins", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/hooks/resolve",
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
    assert.equal(body.jsLint, false);
  });
});
