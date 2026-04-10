import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSettingsJson, buildMcpJson } from "./container-settings.js";
import type {
  SettingsOpts,
  McpOpts,
  SettingsJson,
  McpJson,
  MatcherEntry,
} from "./container-settings.js";

// Helper to extract matchers from settings
function getPreMatchers(settings: SettingsJson): MatcherEntry[] {
  return settings.hooks.PreToolUse;
}

function getPostMatchers(settings: SettingsJson): MatcherEntry[] | undefined {
  return settings.hooks.PostToolUse;
}

function getBashHookCommands(settings: SettingsJson): string[] {
  const bash = getPreMatchers(settings).find((m) => m.matcher === "Bash");
  return bash ? bash.hooks.map((h) => h.command) : [];
}

describe("buildSettingsJson", () => {
  it("workspaceReadonly=false, all other flags false: guard-branch + inject-agent-header, no PostToolUse", () => {
    const opts: SettingsOpts = {
      buildIntercept: false,
      cppLint: false,
      jsLint: false,
      gitSync: false,
      workspaceReadonly: false,
    };
    const result = buildSettingsJson(opts);
    const cmds = getBashHookCommands(result);

    assert.equal(cmds.length, 2); // guard-branch + inject-agent-header
    assert.ok(cmds[0].includes("guard-branch.sh"));
    assert.ok(cmds[1].includes("inject-agent-header.sh"));
    assert.equal(getPreMatchers(result).length, 1); // only Bash matcher
    assert.equal(getPostMatchers(result), undefined);
  });

  it("workspaceReadonly=true, all other flags false: only inject-agent-header (1 hook)", () => {
    const opts: SettingsOpts = {
      buildIntercept: false,
      cppLint: false,
      jsLint: false,
      gitSync: false,
      workspaceReadonly: true,
    };
    const result = buildSettingsJson(opts);
    const cmds = getBashHookCommands(result);

    assert.equal(cmds.length, 1); // only inject-agent-header, no guard-branch
    assert.ok(cmds[0].includes("inject-agent-header.sh"));
    assert.equal(getPreMatchers(result).length, 1); // only Bash matcher
    assert.equal(getPostMatchers(result), undefined);
  });

  it("buildIntercept only: intercept + block-push + inject-agent-header", () => {
    const opts: SettingsOpts = {
      buildIntercept: true,
      cppLint: false,
      jsLint: false,
      gitSync: false,
      workspaceReadonly: false,
    };
    const result = buildSettingsJson(opts);
    const cmds = getBashHookCommands(result);

    assert.ok(cmds.some((c) => c.includes("intercept_build_test.sh")));
    assert.ok(cmds.some((c) => c.includes("block-push-passthrough.sh")));
    assert.ok(cmds.some((c) => c.includes("inject-agent-header.sh")));
    assert.ok(cmds.some((c) => c.includes("guard-branch.sh")));
    assert.equal(getPostMatchers(result), undefined);
  });

  it("cppLint only: inject-agent-header + Edit/Write lint matchers", () => {
    const opts: SettingsOpts = {
      buildIntercept: false,
      cppLint: true,
      jsLint: false,
      gitSync: false,
      workspaceReadonly: false,
    };
    const result = buildSettingsJson(opts);
    const matchers = getPreMatchers(result);

    assert.equal(matchers.length, 3); // Bash, Edit, Write
    assert.equal(matchers[1].matcher, "Edit");
    assert.ok(matchers[1].hooks[0].command.includes("lint-cpp-diff.mjs"));
    assert.equal(matchers[2].matcher, "Write");
    assert.ok(matchers[2].hooks[0].command.includes("lint-cpp-diff.mjs"));
  });

  it("jsLint only: PostToolUse Edit/Write with lint-format", () => {
    const opts: SettingsOpts = {
      buildIntercept: false,
      cppLint: false,
      jsLint: true,
      gitSync: false,
      workspaceReadonly: false,
    };
    const result = buildSettingsJson(opts);
    const post = getPostMatchers(result);

    assert.ok(post != null);
    assert.equal(post.length, 2); // Edit, Write
    assert.equal(post[0].matcher, "Edit");
    assert.ok(post[0].hooks[0].command.includes("lint-format.sh"));
    assert.equal(post[1].matcher, "Write");
    assert.ok(post[1].hooks[0].command.includes("lint-format.sh"));
    // No PreToolUse lint matchers
    assert.equal(getPreMatchers(result).length, 1); // only Bash
  });

  it("gitSync only: PostToolUse with push-after-commit", () => {
    const opts: SettingsOpts = {
      buildIntercept: false,
      cppLint: false,
      jsLint: false,
      gitSync: true,
      workspaceReadonly: false,
    };
    const result = buildSettingsJson(opts);
    const post = getPostMatchers(result);

    assert.ok(post != null);
    assert.equal(post.length, 1);
    assert.equal(post[0].matcher, "Bash");
    assert.ok(post[0].hooks[0].command.includes("push-after-commit.sh"));
  });

  it("all true: all hooks present", () => {
    const opts: SettingsOpts = {
      buildIntercept: true,
      cppLint: true,
      jsLint: false,
      gitSync: true,
      workspaceReadonly: false,
    };
    const result = buildSettingsJson(opts);
    const cmds = getBashHookCommands(result);

    // Bash hooks: guard-branch, intercept, block-push, inject-agent-header
    assert.ok(cmds.some((c) => c.includes("guard-branch.sh")));
    assert.ok(cmds.some((c) => c.includes("intercept_build_test.sh")));
    assert.ok(cmds.some((c) => c.includes("block-push-passthrough.sh")));
    assert.ok(cmds.some((c) => c.includes("inject-agent-header.sh")));

    // Edit and Write matchers
    const matchers = getPreMatchers(result);
    assert.equal(matchers.length, 3);
    assert.equal(matchers[1].matcher, "Edit");
    assert.equal(matchers[2].matcher, "Write");

    // PostToolUse
    const post = getPostMatchers(result);
    assert.ok(post != null);
    assert.ok(post[0].hooks[0].command.includes("push-after-commit.sh"));
  });

  it("workspaceReadonly=true: no guard-branch regardless of other flags", () => {
    const opts: SettingsOpts = {
      buildIntercept: true,
      cppLint: true,
      jsLint: false,
      gitSync: true,
      workspaceReadonly: true,
    };
    const result = buildSettingsJson(opts);
    const cmds = getBashHookCommands(result);

    assert.ok(
      !cmds.some((c) => c.includes("guard-branch.sh")),
      "guard-branch should not be present",
    );
    // Other hooks still present
    assert.ok(cmds.some((c) => c.includes("intercept_build_test.sh")));
    assert.ok(cmds.some((c) => c.includes("inject-agent-header.sh")));
  });

  it("workspaceReadonly=false: guard-branch present", () => {
    const opts: SettingsOpts = {
      buildIntercept: false,
      cppLint: false,
      jsLint: false,
      gitSync: false,
      workspaceReadonly: false,
    };
    const result = buildSettingsJson(opts);
    const cmds = getBashHookCommands(result);

    assert.ok(cmds.some((c) => c.includes("guard-branch.sh")));
  });

  it("hook commands use /claude-hooks/ prefix", () => {
    const opts: SettingsOpts = {
      buildIntercept: true,
      cppLint: true,
      jsLint: false,
      gitSync: true,
      workspaceReadonly: false,
    };
    const result = buildSettingsJson(opts);

    // Collect all hook commands from all matchers (PreToolUse + PostToolUse)
    const allCommands: string[] = [];
    for (const matcher of getPreMatchers(result)) {
      for (const h of matcher.hooks) {
        allCommands.push(h.command);
      }
    }
    const post = getPostMatchers(result);
    if (post) {
      for (const matcher of post) {
        for (const h of matcher.hooks) {
          allCommands.push(h.command);
        }
      }
    }

    // Ensure we actually collected commands from Bash, Edit, and Write matchers
    assert.ok(allCommands.length > 0, "Expected at least one hook command");
    const matcherNames = getPreMatchers(result).map((m) => m.matcher);
    assert.ok(matcherNames.includes("Edit"), "Expected Edit matcher");
    assert.ok(matcherNames.includes("Write"), "Expected Write matcher");

    for (const cmd of allCommands) {
      assert.ok(
        cmd.includes("/claude-hooks/"),
        `Expected /claude-hooks/ in: ${cmd}`,
      );
    }
  });
});

describe("buildMcpJson", () => {
  it("chatRoom set: full chat server config", () => {
    const opts: McpOpts = {
      chatRoom: "design-room",
      serverUrl: "http://localhost:9100",
      agentName: "agent-1",
      sessionToken: "tok-123",
    };
    const result: McpJson = buildMcpJson(opts);

    assert.ok(result.mcpServers.chat);
    assert.equal(result.mcpServers.chat.command, "node");
    assert.deepEqual(result.mcpServers.chat.args, [
      "/mcp-servers/chat-channel.mjs",
    ]);
    assert.equal(
      result.mcpServers.chat.env.SERVER_URL,
      "http://localhost:9100",
    );
    assert.equal(result.mcpServers.chat.env.AGENT_NAME, "agent-1");
    assert.equal(result.mcpServers.chat.env.SESSION_TOKEN, "tok-123");
  });

  it("chatRoom null: empty mcpServers", () => {
    const opts: McpOpts = {
      chatRoom: null,
      serverUrl: "http://localhost:9100",
      agentName: "agent-1",
      sessionToken: "tok-123",
    };
    const result: McpJson = buildMcpJson(opts);

    assert.deepEqual(result.mcpServers, {});
  });

  it("chatRoom undefined: empty mcpServers", () => {
    const opts: McpOpts = {
      serverUrl: "http://localhost:9100",
      agentName: "agent-1",
      sessionToken: "tok-123",
    };
    const result: McpJson = buildMcpJson(opts);

    assert.deepEqual(result.mcpServers, {});
  });
});
