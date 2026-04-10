import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createDrizzleTestApp,
  type DrizzleTestContext,
} from "../drizzle-test-helper.js";
import { createTestConfig } from "../test-helper.js";
import type { ResolvedProjectConfig } from "../config-resolver.js";
import configPlugin from "./config.js";

describe("GET /config routes", () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it("GET /config returns project IDs", async () => {
    const config = createTestConfig();
    await ctx.app.register(configPlugin, { config });

    const res = await ctx.app.inject({ method: "GET", url: "/config" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().projectIds, ["default"]);
  });

  it("GET /config returns multiple project IDs", async () => {
    const config = createTestConfig({
      resolvedProjects: {
        alpha: { name: "Alpha", path: "/a", bareRepoPath: "/a.git" },
        beta: { name: "Beta", path: "/b", bareRepoPath: "/b.git" },
      },
    });
    await ctx.app.register(configPlugin, { config });

    const res = await ctx.app.inject({ method: "GET", url: "/config" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().projectIds.sort(), ["alpha", "beta"]);
  });

  it("GET /config/:projectId returns resolved config", async () => {
    const config = createTestConfig();
    await ctx.app.register(configPlugin, { config });

    const res = await ctx.app.inject({ method: "GET", url: "/config/default" });
    assert.equal(res.statusCode, 200);
    const body: ResolvedProjectConfig = res.json();
    assert.equal(body.projectId, "default");
    assert.equal(body.name, "TestProject");
    assert.equal(body.bareRepoPath, "/tmp/test-repo.git");
    assert.equal(body.serverPort, 9100);
    assert.deepEqual(body.hooks, {
      buildIntercept: null,
      cppLint: null,
      jsLint: null,
    });
  });

  it("GET /config/:projectId returns 404 for unknown project", async () => {
    const config = createTestConfig();
    await ctx.app.register(configPlugin, { config });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/config/nonexistent",
    });
    assert.equal(res.statusCode, 404);
  });

  it("GET /config/:projectId returns 400 for invalid projectId format", async () => {
    const config = createTestConfig();
    await ctx.app.register(configPlugin, { config });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/config/bad%20id!",
    });
    assert.equal(res.statusCode, 400);
  });
});
