import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyExit } from './exit-classifier.js';

describe('classifyExit', () => {
  // --- Auth failure ---

  it('detects authentication_error', () => {
    const result = classifyExit({
      logTail: 'Error: authentication_error - invalid key',
      elapsedSeconds: 30,
      outputLineCount: 10,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /authentication failure/);
  });

  it('detects "Invalid authentication credentials" (case-insensitive)', () => {
    const result = classifyExit({
      logTail: 'API Error: invalid authentication credentials returned',
      elapsedSeconds: 45,
      outputLineCount: 20,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /authentication failure/);
  });

  it('detects "Failed to authenticate"', () => {
    const result = classifyExit({
      logTail: 'Failed to authenticate. API Error: 401 Unauthorized',
      elapsedSeconds: 5,
      outputLineCount: 2,
    });
    assert.equal(result.abnormal, true);
    // Auth takes priority over rapid-exit
    assert.match(result.reason!, /authentication failure/);
  });

  // --- Token exhaustion ---

  it('detects token limit', () => {
    const result = classifyExit({
      logTail: 'You have exceeded your token limit for this session.',
      elapsedSeconds: 300,
      outputLineCount: 500,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /token or rate limit/);
  });

  it('detects rate limit exceeded', () => {
    const result = classifyExit({
      logTail: 'Error: rate limit exceeded, please wait before retrying',
      elapsedSeconds: 60,
      outputLineCount: 50,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /token or rate limit/);
  });

  it('detects quota exceeded', () => {
    const result = classifyExit({
      logTail: 'Your organization quota exceeded for the current billing period',
      elapsedSeconds: 120,
      outputLineCount: 100,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /token or rate limit/);
  });

  it('detects overloaded_error', () => {
    const result = classifyExit({
      logTail: 'API returned overloaded_error — try again later',
      elapsedSeconds: 200,
      outputLineCount: 150,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /token or rate limit/);
  });

  it('detects billing error', () => {
    const result = classifyExit({
      logTail: 'billing error: payment method declined',
      elapsedSeconds: 15,
      outputLineCount: 8,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /token or rate limit/);
  });

  it('detects context limit', () => {
    const result = classifyExit({
      logTail: 'context limit reached, conversation truncated',
      elapsedSeconds: 600,
      outputLineCount: 1000,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /token or rate limit/);
  });

  it('detects "session limit reached"', () => {
    const result = classifyExit({
      logTail: 'Error: session limit reached, please start a new conversation',
      elapsedSeconds: 500,
      outputLineCount: 300,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /token or rate limit/);
  });

  it('detects "token exhausted"', () => {
    const result = classifyExit({
      logTail: 'API token exhausted for current billing cycle',
      elapsedSeconds: 400,
      outputLineCount: 250,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /token or rate limit/);
  });

  it('detects "max token reached for this request"', () => {
    const result = classifyExit({
      logTail: 'Error: max token reached for this request, truncating response',
      elapsedSeconds: 200,
      outputLineCount: 150,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /token or rate limit/);
  });

  // --- Rapid exit ---

  it('detects rapid exit (<10s, <5 lines)', () => {
    const result = classifyExit({
      logTail: 'Some generic error',
      elapsedSeconds: 3,
      outputLineCount: 2,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /rapid exit/);
    assert.match(result.reason!, /3s/);
    assert.match(result.reason!, /2 lines/);
  });

  it('does not trigger rapid exit at exactly 10 seconds', () => {
    const result = classifyExit({
      logTail: 'Some generic output',
      elapsedSeconds: 10,
      outputLineCount: 3,
    });
    assert.equal(result.abnormal, false);
    assert.equal(result.reason, null);
  });

  it('does not trigger rapid exit with 5+ lines', () => {
    const result = classifyExit({
      logTail: 'Line output',
      elapsedSeconds: 5,
      outputLineCount: 5,
    });
    assert.equal(result.abnormal, false);
    assert.equal(result.reason, null);
  });

  // --- Clean exit ---

  it('returns clean for normal exit', () => {
    const result = classifyExit({
      logTail: 'Agent completed task successfully.\nAll tests pass.',
      elapsedSeconds: 600,
      outputLineCount: 500,
    });
    assert.equal(result.abnormal, false);
    assert.equal(result.reason, null);
  });

  it('returns clean for empty log with sufficient runtime', () => {
    const result = classifyExit({
      logTail: '',
      elapsedSeconds: 120,
      outputLineCount: 50,
    });
    assert.equal(result.abnormal, false);
    assert.equal(result.reason, null);
  });

  // --- Priority: auth > token > rapid ---

  it('auth pattern takes priority over rapid exit', () => {
    const result = classifyExit({
      logTail: 'Failed to authenticate',
      elapsedSeconds: 2,
      outputLineCount: 1,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /authentication failure/);
  });

  it('token pattern takes priority over rapid exit', () => {
    const result = classifyExit({
      logTail: 'token limit reached',
      elapsedSeconds: 3,
      outputLineCount: 2,
    });
    assert.equal(result.abnormal, true);
    assert.match(result.reason!, /token or rate limit/);
  });
});
