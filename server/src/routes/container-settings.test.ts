import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import containerSettingsPlugin from './container-settings.js';

describe('GET /agents/:name/settings.json', () => {
  let ctx: DrizzleTestContext;

  before(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(containerSettingsPlugin);
  });

  after(async () => {
    await ctx?.app.close();
    await ctx?.cleanup();
  });

  it('returns default settings with no query flags', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/test-agent/settings.json',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.hooks);
    assert.ok(Array.isArray(body.hooks.PreToolUse));
    // Default: workspaceReadonly=false => guard-branch + inject-agent-header
    const bashMatcher = body.hooks.PreToolUse.find((m: { matcher: string }) => m.matcher === 'Bash');
    assert.ok(bashMatcher);
    assert.equal(bashMatcher.hooks.length, 2);
  });

  it('returns all hooks when all flags are true', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/test-agent/settings.json?build=true&lint=true&gitSync=true&readonly=false',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    // Bash hooks: guard-branch, intercept, block-push, inject-agent-header
    const bashMatcher = body.hooks.PreToolUse.find((m: { matcher: string }) => m.matcher === 'Bash');
    assert.equal(bashMatcher.hooks.length, 4);
    // Edit and Write matchers for lint
    assert.equal(body.hooks.PreToolUse.length, 3);
    // PostToolUse for gitSync
    assert.ok(body.hooks.PostToolUse);
    assert.equal(body.hooks.PostToolUse.length, 1);
  });

  it('rejects invalid agent name', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/bad%20name!!/settings.json',
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('GET /agents/:name/mcp.json', () => {
  let ctx: DrizzleTestContext;

  before(async () => {
    ctx = await createDrizzleTestApp();
    await ctx.app.register(containerSettingsPlugin);
  });

  after(async () => {
    await ctx?.app.close();
    await ctx?.cleanup();
  });

  it('returns empty mcpServers when no chatRoom', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/test-agent/mcp.json',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.mcpServers, {});
  });

  it('returns chat MCP config when chatRoom and headers are set', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/test-agent/mcp.json?chatRoom=design-room&serverUrl=http://localhost:9100',
      headers: { 'x-session-token': 'tok-abc' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.mcpServers.chat);
    assert.equal(body.mcpServers.chat.env.AGENT_NAME, 'test-agent');
    assert.equal(body.mcpServers.chat.env.SESSION_TOKEN, 'tok-abc');
    assert.equal(body.mcpServers.chat.env.SERVER_URL, 'http://localhost:9100');
  });

  it('uses route param name as agentName, not query', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/my-agent/mcp.json?chatRoom=room&serverUrl=http://localhost:9100',
      headers: { 'x-session-token': 'tok-xyz' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.mcpServers.chat.env.AGENT_NAME, 'my-agent');
  });

  it('returns 400 when chatRoom set but serverUrl missing', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/test-agent/mcp.json?chatRoom=room',
      headers: { 'x-session-token': 'tok-abc' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 when chatRoom set but X-Session-Token missing', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/test-agent/mcp.json?chatRoom=room&serverUrl=http://localhost:9100',
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects invalid agent name', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/agents/bad%20name!!/mcp.json',
    });
    assert.equal(res.statusCode, 400);
  });
});
