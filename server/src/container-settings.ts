/**
 * Container settings rendering.
 *
 * Produces the same JSON structures that entrypoint.sh builds via jq,
 * so the container can fetch its settings from the coordination server.
 */

export interface SettingsOpts {
  buildIntercept: boolean;
  cppLint: boolean;
  gitSync: boolean;
  workspaceReadonly: boolean;
}

export interface McpOpts {
  chatRoom?: string | null;
  serverUrl: string;
  agentName: string;
  sessionToken: string;
}

const HOOKS_PREFIX = '/claude-hooks/';

interface Hook {
  type: 'command';
  command: string;
}

interface Matcher {
  matcher: string;
  hooks: Hook[];
}

function hook(script: string): Hook {
  return { type: 'command', command: `bash ${HOOKS_PREFIX}${script}` };
}

function pythonHook(script: string): Hook {
  return { type: 'command', command: `python3 ${HOOKS_PREFIX}${script}` };
}

export function buildSettingsJson(opts: SettingsOpts): object {
  // Build PreToolUse Bash hooks array.
  // inject-agent-header is always present; others are prepended when enabled.
  const bashHooks: Hook[] = [];

  // guard-branch for writable workspaces (prepended first so it runs first)
  if (!opts.workspaceReadonly) {
    bashHooks.push(hook('guard-branch.sh'));
  }

  // build intercept hooks
  if (opts.buildIntercept) {
    bashHooks.push(hook('intercept_build_test.sh'));
    bashHooks.push(hook('block-push-passthrough.sh'));
  }

  // inject-agent-header is always last in the Bash hooks
  bashHooks.push(hook('inject-agent-header.sh'));

  const preMatchers: Matcher[] = [{ matcher: 'Bash', hooks: bashHooks }];

  // C++ lint matchers for Edit and Write
  if (opts.cppLint) {
    const lintHook = pythonHook('lint-cpp-diff.py');
    preMatchers.push({ matcher: 'Edit', hooks: [lintHook] });
    preMatchers.push({ matcher: 'Write', hooks: [lintHook] });
  }

  // PostToolUse matchers
  const postMatchers: Matcher[] = [];
  if (opts.gitSync) {
    postMatchers.push({ matcher: 'Bash', hooks: [hook('push-after-commit.sh')] });
  }

  const hooks: Record<string, Matcher[]> = { PreToolUse: preMatchers };
  if (postMatchers.length > 0) {
    hooks.PostToolUse = postMatchers;
  }

  return { hooks };
}

export function buildMcpJson(opts: McpOpts): object {
  if (opts.chatRoom) {
    return {
      mcpServers: {
        chat: {
          command: 'node',
          args: ['/mcp-servers/chat-channel.mjs'],
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
