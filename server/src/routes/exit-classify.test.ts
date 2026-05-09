import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createDrizzleTestApp,
  type DrizzleTestContext,
} from "../drizzle-test-helper.js";
import exitClassifyPlugin from "./exit-classify.js";

describe("POST /agents/:name/exit-classify", () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(exitClassifyPlugin);
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  it("returns abnormal=true when result event reports is_error:true", async () => {
    const logTail =
      '{"type":"result","subtype":"error_during_execution","is_error":true,"api_error_status":"rate_limit_error","result":"hit a 429"}';
    const res = await ctx.app.inject({
      method: "POST",
      url: "/agents/test-agent/exit-classify",
      payload: { logTail, elapsedSeconds: 200, outputLineCount: 150 },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.abnormal, true);
    assert.match(body.reason, /rate_limit_error/);
  });

  it("returns abnormal=true for rapid exit when no result event present", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/agents/test-agent/exit-classify",
      payload: {
        logTail: "exited",
        elapsedSeconds: 2,
        outputLineCount: 1,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.abnormal, true);
    assert.match(body.reason, /rapid exit/);
  });

  it("returns abnormal=false for clean exit", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/agents/test-agent/exit-classify",
      payload: {
        logTail: "All tasks completed successfully.",
        elapsedSeconds: 600,
        outputLineCount: 500,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.abnormal, false);
    assert.equal(body.reason, null);
  });

  it("returns abnormal=false when log contains trigger words alongside a successful result event", async () => {
    const logTail = [
      "sub-agent mentioned the session limit incidentally",
      '{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":1280009,"result":"done","stop_reason":"end_turn","session_id":"abc","terminal_reason":"completed"}',
    ].join("\n");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/agents/test-agent/exit-classify",
      payload: { logTail, elapsedSeconds: 1280, outputLineCount: 500 },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.abnormal, false);
    assert.equal(body.reason, null);
  });

  it("returns abnormal=false when log mentions trigger words but no result event is present", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/agents/test-agent/exit-classify",
      payload: {
        logTail: "rate limit exceeded — but no terminal result event",
        elapsedSeconds: 60,
        outputLineCount: 50,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.abnormal, false);
    assert.equal(body.reason, null);
  });

  it("returns 400 for missing required fields", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/agents/test-agent/exit-classify",
      payload: { logTail: "some log" },
    });
    assert.equal(res.statusCode, 400);
  });

  it("returns abnormal=true for non-zero exitCode with no result event (long-run crash)", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/agents/test-agent/exit-classify",
      payload: {
        logTail: "lots of activity, then SIGKILL",
        elapsedSeconds: 3700,
        outputLineCount: 12000,
        exitCode: 137,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.abnormal, true);
    assert.match(body.reason, /crashed without status/);
    assert.match(body.reason, /exit=137/);
  });

  it("returns abnormal=false when exitCode=0 on a long run with no result event", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/agents/test-agent/exit-classify",
      payload: {
        logTail: "lots of activity, no terminal frame in the slice",
        elapsedSeconds: 1800,
        outputLineCount: 5000,
        exitCode: 0,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.abnormal, false);
    assert.equal(body.reason, null);
  });

  it("returns 400 for negative elapsedSeconds", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/agents/test-agent/exit-classify",
      payload: {
        logTail: "test",
        elapsedSeconds: -1,
        outputLineCount: 5,
      },
    });
    assert.equal(res.statusCode, 400);
  });
});
