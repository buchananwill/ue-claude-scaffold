import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyExit } from "./exit-classifier.js";

describe("classifyExit — result event path", () => {
  it("returns clean when result event reports is_error:false", () => {
    // Regression: long orchestrator runs whose stream-json output
    // incidentally mentions "context limit" / "session limit" in agent prose
    // must not be flagged abnormal when the terminal result event reports
    // success.
    const logTail = [
      "sub-agent: be careful about the context limit",
      "sub-agent: session limit advice ignored",
      '{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":1280009,"result":"done","stop_reason":"end_turn","session_id":"abc","terminal_reason":"completed"}',
    ].join("\n");
    const result = classifyExit({
      logTail,
      elapsedSeconds: 1280,
      outputLineCount: 500,
    });
    assert.equal(result.abnormal, false);
    assert.equal(result.reason, null);
  });

  it("returns abnormal when result event reports is_error:true with api_error_status", () => {
    const logTail =
      '{"type":"result","subtype":"error_during_execution","is_error":true,"api_error_status":"rate_limit_error","result":"hit a 429"}';
    const result = classifyExit({
      logTail,
      elapsedSeconds: 200,
      outputLineCount: 150,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /rate_limit_error/);
  });

  it("uses subtype as the reason when api_error_status is null", () => {
    const logTail =
      '{"type":"result","subtype":"error_max_turns","is_error":true,"api_error_status":null,"result":"max turns"}';
    const result = classifyExit({
      logTail,
      elapsedSeconds: 12,
      outputLineCount: 30,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /error_max_turns/);
  });

  it("uses the most recent result event when multiple are present", () => {
    const logTail = [
      '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"first attempt failed"}',
      '{"type":"result","subtype":"success","is_error":false,"result":"retry succeeded"}',
    ].join("\n");
    const result = classifyExit({
      logTail,
      elapsedSeconds: 600,
      outputLineCount: 500,
    });
    assert.equal(result.abnormal, false);
  });

  it("ignores malformed result-like lines and keeps scanning earlier ones", () => {
    const logTail = [
      '{"type":"result","subtype":"success","is_error":false,"result":"earlier success"}',
      '{"type":"result", malformed',
    ].join("\n");
    const result = classifyExit({
      logTail,
      elapsedSeconds: 600,
      outputLineCount: 500,
    });
    assert.equal(result.abnormal, false);
  });
});

describe("classifyExit — exit-code path (no result event)", () => {
  it("flags abnormal when exitCode is non-zero on a long run", () => {
    // Regression: a 1-hour task that gets SIGKILLed mid-run produces lots
    // of output, plenty of elapsed time, and NO terminal result event.
    // Without exitCode plumbing this slips through as "clean" — wrong.
    const result = classifyExit({
      logTail: "sub-agent prose, lots of activity, then process killed",
      elapsedSeconds: 3700,
      outputLineCount: 12000,
      exitCode: 137,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /crashed without status/);
    assert.match(result.reason!, /exit=137/);
    assert.match(result.reason!, /3700s/);
  });

  it("flags abnormal when exitCode is 1 (generic failure) with no result event", () => {
    const result = classifyExit({
      logTail: "random output",
      elapsedSeconds: 200,
      outputLineCount: 50,
      exitCode: 1,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /crashed without status/);
    assert.match(result.reason!, /exit=1/);
  });

  it("returns clean when exitCode is 0 on a long run with no result event", () => {
    const result = classifyExit({
      logTail: "lots of output, no terminal result event in the slice we got",
      elapsedSeconds: 1800,
      outputLineCount: 5000,
      exitCode: 0,
    });
    assert.equal(result.abnormal, false);
    assert.equal(result.reason, null);
  });

  it("result event with is_error:false beats a non-zero exitCode", () => {
    const logTail =
      '{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"result":"done"}';
    const result = classifyExit({
      logTail,
      elapsedSeconds: 600,
      outputLineCount: 500,
      exitCode: 1,
    });
    assert.equal(result.abnormal, false);
  });
});

describe("classifyExit — rapid-exit fallback (no exitCode supplied)", () => {
  it("flags rapid exit (<10s, <5 lines)", () => {
    const result = classifyExit({
      logTail: "binary failed to start",
      elapsedSeconds: 3,
      outputLineCount: 2,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /rapid exit/);
    assert.match(result.reason!, /3s/);
    assert.match(result.reason!, /2 lines/);
  });

  it("does not trigger rapid exit at exactly 10 seconds", () => {
    const result = classifyExit({
      logTail: "some output",
      elapsedSeconds: 10,
      outputLineCount: 3,
    });
    assert.equal(result.abnormal, false);
    assert.equal(result.reason, null);
  });

  it("does not trigger rapid exit with 5+ lines", () => {
    const result = classifyExit({
      logTail: "line output",
      elapsedSeconds: 5,
      outputLineCount: 5,
    });
    assert.equal(result.abnormal, false);
    assert.equal(result.reason, null);
  });

  it("returns clean for normal-length log with no result event", () => {
    const result = classifyExit({
      logTail: "Agent completed task successfully.\nAll tests pass.",
      elapsedSeconds: 600,
      outputLineCount: 500,
    });
    assert.equal(result.abnormal, false);
    assert.equal(result.reason, null);
  });

  it("returns clean for empty log with sufficient runtime", () => {
    const result = classifyExit({
      logTail: "",
      elapsedSeconds: 120,
      outputLineCount: 50,
    });
    assert.equal(result.abnormal, false);
    assert.equal(result.reason, null);
  });

  it('does not flag long-running runs whose tail mentions "session limit" but has no result event', () => {
    // The whole point of the redesign: substring co-occurrence is no longer
    // a signal. Without a structured result event, only rapid-exit fires.
    const result = classifyExit({
      logTail:
        "sub-agent prose that mentions a session limit and a token limit and a context limit",
      elapsedSeconds: 770,
      outputLineCount: 500,
    });
    assert.equal(result.abnormal, false);
    assert.equal(result.reason, null);
  });
});
