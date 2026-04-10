/**
 * Container settings rendering.
 *
 * Produces the same JSON structures that entrypoint.sh builds via jq,
 * so the container can fetch its settings from the coordination server.
 */

export interface SettingsOpts {
  buildIntercept: boolean;
  cppLint: boolean;
  jsLint: boolean;
  gitSync: boolean;
  workspaceReadonly: boolean;
}

export interface McpOpts {
  chatRoom?: string | null;
  serverUrl: string;
  agentName: string;
  sessionToken: string;
}

/** A single hook entry in container-settings.json */
export interface HookEntry {
  type: string;
  command: string;
}

/** A matcher + hooks pair used in PreToolUse / PostToolUse arrays */
export interface MatcherEntry {
  matcher: string;
  hooks: HookEntry[];
}

/** Top-level shape returned by buildSettingsJson */
export interface SettingsJson {
  hooks: {
    PreToolUse: MatcherEntry[];
    PostToolUse?: MatcherEntry[];
  };
}

/** A single MCP server entry */
export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Top-level shape returned by buildMcpJson */
export interface McpJson {
  mcpServers: Record<string, McpServerEntry>;
}

const HOOKS_PREFIX = "/claude-hooks/";

interface Hook {
  type: "command";
  command: string;
}

interface Matcher {
  matcher: string;
  hooks: Hook[];
}

function hook(script: string): Hook {
  return { type: "command", command: `bash ${HOOKS_PREFIX}${script}` };
}

function nodeHook(script: string): Hook {
  return { type: "command", command: `node ${HOOKS_PREFIX}${script}` };
}

export function buildSettingsJson(opts: SettingsOpts): SettingsJson {
  // Build PreToolUse Bash hooks array.
  // inject-agent-header is always present; others are prepended when enabled.
  const bashHooks: Hook[] = [];

  // guard-branch for writable workspaces (prepended first so it runs first)
  if (!opts.workspaceReadonly) {
    bashHooks.push(hook("guard-branch.sh"));
  }

  // build intercept hooks
  if (opts.buildIntercept) {
    bashHooks.push(hook("intercept_build_test.sh"));
    bashHooks.push(hook("block-push-passthrough.sh"));
  }

  // inject-agent-header is always last in the Bash hooks
  bashHooks.push(hook("inject-agent-header.sh"));

  const preMatchers: Matcher[] = [{ matcher: "Bash", hooks: bashHooks }];

  // C++ lint matchers for Edit and Write
  if (opts.cppLint) {
    const lintHook = nodeHook("lint-cpp-diff.mjs");
    preMatchers.push({ matcher: "Edit", hooks: [lintHook] });
    preMatchers.push({ matcher: "Write", hooks: [lintHook] });
  }

  // JS lint matcher for Edit and Write (PostToolUse — format + feed violations back)
  const jsLintMatchers: Matcher[] = [];
  if (opts.jsLint) {
    const lintHook = hook("lint-format.sh");
    jsLintMatchers.push({ matcher: "Edit", hooks: [lintHook] });
    jsLintMatchers.push({ matcher: "Write", hooks: [lintHook] });
  }

  // PostToolUse matchers
  const postMatchers: Matcher[] = [...jsLintMatchers];
  if (opts.gitSync) {
    postMatchers.push({
      matcher: "Bash",
      hooks: [hook("push-after-commit.sh")],
    });
  }

  const result: SettingsJson = { hooks: { PreToolUse: preMatchers } };
  if (postMatchers.length > 0) {
    result.hooks.PostToolUse = postMatchers;
  }

  return result;
}

export function buildMcpJson(opts: McpOpts): McpJson {
  if (opts.chatRoom) {
    return {
      mcpServers: {
        chat: {
          command: "node",
          args: ["/mcp-servers/chat-channel.mjs"],
          env: {
            SERVER_URL: opts.serverUrl,
            AGENT_NAME: opts.agentName,
            SESSION_TOKEN: opts.sessionToken,
          },
        },
      },
    };
  }

  return { mcpServers: {} };
}
