import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSettingsJson, buildMcpJson } from './container-settings.js';
import type { SettingsOpts, McpOpts, SettingsJson, McpJson, MatcherEntry } from './container-settings.js';

// Helper to extract matchers from settings
function getPreMatchers(settings: SettingsJson): MatcherEntry[] {
  return settings.hooks.PreToolUse;
}

function getPostMatchers(settings: SettingsJson): MatcherEntry[] | undefined {
  return settings.hooks.PostToolUse;
}

function getBashHookCommands(settings: SettingsJson): string[] {
  const bash = getPreMatchers(settings).find((m) => m.matcher === 'Bash');
  return bash ? bash.hooks.map((h) => h.command) : [];
}

describe('buildSettingsJson', () => {
  it('workspaceReadonly=false, all other flags false: guard-branch + inject-agent-header, no PostToolUse', () => {
    const opts: SettingsOpts = { buildIntercept: false, cppLint: false, gitSync: false, workspaceReadonly: false };
    const result = buildSettingsJson(opts);
    const cmds = getBashHookCommands(result);

    assert.equal(cmds.length, 2); // guard-branch + inject-agent-header
    assert.ok(cmds[0].includes('guard-branch.sh'));
    assert.ok(cmds[1].includes('inject-agent-header.sh'));
    assert.equal(getPreMatchers(result).length, 1); // only Bash matcher
    assert.equal(getPostMatchers(result), undefined);
  });

  it('workspaceReadonly=true, all other flags false: only inject-agent-header (1 hook)', () => {
    const opts: SettingsOpts = { buildIntercept: false, cppLint: false, gitSync: false, workspaceReadonly: true };
    const result = buildSettingsJson(opts);
    const cmds = getBashHookCommands(result);

    assert.equal(cmds.length, 1); // only inject-agent-header, no guard-branch
    assert.ok(cmds[0].includes('inject-agent-header.sh'));
    assert.equal(getPreMatchers(result).length, 1); // only Bash matcher
    assert.equal(getPostMatchers(result), undefined);
  });

  it('buildIntercept only: intercept + block-push + inject-agent-header', () => {
    const opts: SettingsOpts = { buildIntercept: true, cppLint: false, gitSync: false, workspaceReadonly: false };
    const result = buildSettingsJson(opts);
    const cmds = getBashHookCommands(result);

    assert.ok(cmds.some(c => c.includes('intercept_build_test.sh')));
    assert.ok(cmds.some(c => c.includes('block-push-passthrough.sh')));
    assert.ok(cmds.some(c => c.includes('inject-agent-header.sh')));
    assert.ok(cmds.some(c => c.includes('guard-branch.sh')));
    assert.equal(getPostMatchers(result), undefined);
  });

  it('cppLint only: inject-agent-header + Edit/Write lint matchers', () => {
    const opts: SettingsOpts = { buildIntercept: false, cppLint: true, gitSync: false, workspaceReadonly: false };
    const result = buildSettingsJson(opts);
    const matchers = getPreMatchers(result);

    assert.equal(matchers.length, 3); // Bash, Edit, Write
    assert.equal(matchers[1].matcher, 'Edit');
    assert.ok(matchers[1].hooks[0].command.includes('lint-cpp-diff.py'));
    assert.equal(matchers[2].matcher, 'Write');
    assert.ok(matchers[2].hooks[0].command.includes('lint-cpp-diff.py'));
  });

  it('gitSync only: PostToolUse with push-after-commit', () => {
    const opts: SettingsOpts = { buildIntercept: false, cppLint: false, gitSync: true, workspaceReadonly: false };
    const result = buildSettingsJson(opts);
    const post = getPostMatchers(result);

    assert.ok(post);
    assert.equal(post!.length, 1);
    assert.equal(post![0].matcher, 'Bash');
    assert.ok(post![0].hooks[0].command.includes('push-after-commit.sh'));
  });

  it('all true: all hooks present', () => {
    const opts: SettingsOpts = { buildIntercept: true, cppLint: true, gitSync: true, workspaceReadonly: false };
    const result = buildSettingsJson(opts);
    const cmds = getBashHookCommands(result);

    // Bash hooks: guard-branch, intercept, block-push, inject-agent-header
    assert.ok(cmds.some(c => c.includes('guard-branch.sh')));
    assert.ok(cmds.some(c => c.includes('intercept_build_test.sh')));
    assert.ok(cmds.some(c => c.includes('block-push-passthrough.sh')));
    assert.ok(cmds.some(c => c.includes('inject-agent-header.sh')));

    // Edit and Write matchers
    const matchers = getPreMatchers(result);
    assert.equal(matchers.length, 3);
    assert.equal(matchers[1].matcher, 'Edit');
    assert.equal(matchers[2].matcher, 'Write');

    // PostToolUse
    const post = getPostMatchers(result);
    assert.ok(post);
    assert.ok(post![0].hooks[0].command.includes('push-after-commit.sh'));
  });

  it('workspaceReadonly=true: no guard-branch regardless of other flags', () => {
    const opts: SettingsOpts = { buildIntercept: true, cppLint: true, gitSync: true, workspaceReadonly: true };
    const result = buildSettingsJson(opts);
    const cmds = getBashHookCommands(result);

    assert.ok(!cmds.some(c => c.includes('guard-branch.sh')), 'guard-branch should not be present');
    // Other hooks still present
    assert.ok(cmds.some(c => c.includes('intercept_build_test.sh')));
    assert.ok(cmds.some(c => c.includes('inject-agent-header.sh')));
  });

  it('workspaceReadonly=false: guard-branch present', () => {
    const opts: SettingsOpts = { buildIntercept: false, cppLint: false, gitSync: false, workspaceReadonly: false };
    const result = buildSettingsJson(opts);
    const cmds = getBashHookCommands(result);

    assert.ok(cmds.some(c => c.includes('guard-branch.sh')));
  });

  it('hook commands use /claude-hooks/ prefix', () => {
    const opts: SettingsOpts = { buildIntercept: true, cppLint: true, gitSync: true, workspaceReadonly: false };
    const result = buildSettingsJson(opts);
    const cmds = getBashHookCommands(result);

    for (const cmd of cmds) {
      assert.ok(cmd.includes('/claude-hooks/'), `Expected /claude-hooks/ in: ${cmd}`);
    }
  });
});

describe('buildMcpJson', () => {
  it('chatRoom set: full chat server config', () => {
    const opts: McpOpts = {
      chatRoom: 'design-room',
      serverUrl: 'http://localhost:9100',
      agentName: 'agent-1',
      sessionToken: 'tok-123',
    };
    const result: McpJson = buildMcpJson(opts);

    assert.ok(result.mcpServers.chat);
    assert.equal(result.mcpServers.chat.command, 'node');
    assert.deepEqual(result.mcpServers.chat.args, ['/mcp-servers/chat-channel.mjs']);
    assert.equal(result.mcpServers.chat.env.SERVER_URL, 'http://localhost:9100');
    assert.equal(result.mcpServers.chat.env.AGENT_NAME, 'agent-1');
    assert.equal(result.mcpServers.chat.env.SESSION_TOKEN, 'tok-123');
  });

  it('chatRoom null: empty mcpServers', () => {
    const opts: McpOpts = {
      chatRoom: null,
      serverUrl: 'http://localhost:9100',
      agentName: 'agent-1',
      sessionToken: 'tok-123',
    };
    const result: McpJson = buildMcpJson(opts);

    assert.deepEqual(result.mcpServers, {});
  });

  it('chatRoom undefined: empty mcpServers', () => {
    const opts: McpOpts = {
      serverUrl: 'http://localhost:9100',
      agentName: 'agent-1',
      sessionToken: 'tok-123',
    };
    const result: McpJson = buildMcpJson(opts);

    assert.deepEqual(result.mcpServers, {});
  });
});
