#!/bin/bash
# container/lib/workspace-setup.sh — Clone, checkout, git-exclude, agent snapshot, plugin symlinks.
# Sourced by entrypoint.sh; do not execute directly.

_setup_workspace() {
    # ── Clone from the local bare repo (bind-mounted at /repo.git) ──────────
    git config --global --add safe.directory /repo.git
    git config --global --add safe.directory /workspace

    if [ ! -d /workspace/.git ]; then
        echo "Cloning from local bare repo..."
        git clone /repo.git /workspace --branch "$WORK_BRANCH"
    fi

    cd /workspace

    # Ensure we're on the right branch
    git checkout "$WORK_BRANCH" 2>/dev/null || git checkout -b "$WORK_BRANCH"

    # Pull latest from bare repo (picks up plans merged by the server)
    git fetch origin "$WORK_BRANCH" 2>/dev/null || true
    git reset --hard "origin/${WORK_BRANCH}" 2>/dev/null || true

    # Configure git for container commits
    git config user.email "claude-docker@localhost"
    git config user.name "Claude Code (Docker)"
    git config core.autocrlf false

    # ── Exclude Claude Code runtime metadata from git ───────────────────────
    cat > .git/info/exclude <<'EXCL'
.claude/
EXCL
}

_snapshot_agents() {
    # ── Snapshot staged agents into container-local directory ────────────────
    AGENTS_DIR="/home/claude/.claude/agents"
    mkdir -p "$AGENTS_DIR"
    if [ -d /staged-agents ] && ls /staged-agents/*.md &>/dev/null; then
        cp /staged-agents/* "$AGENTS_DIR/"
        echo "── Agent definitions snapshotted ──"
        ls -1 "$AGENTS_DIR"/*.md 2>/dev/null | while read -r f; do echo "  $(basename "$f")"; done
        # Verify the requested agent type is present
        if [ ! -f "$AGENTS_DIR/${AGENT_TYPE}.md" ]; then
            echo "ERROR: Agent type '${AGENT_TYPE}' not found in snapshotted agents." >&2
            echo "Available agents:" >&2
            ls -1 "$AGENTS_DIR"/*.md 2>/dev/null | xargs -I{} basename {} .md >&2
            echo "Check AGENT_TYPE in .env and ensure the agent was compiled." >&2
            exit 1
        fi
        echo "Verified: ${AGENT_TYPE}.md is present."
    else
        echo "WARNING: No agent definitions found at /staged-agents." >&2
        echo "The container will run without an agent definition." >&2
    fi
    echo ""
}

_setup_hooks() {
    # ── Read access scope from compiler sidecar metadata ────────────────────
    ACCESS_SCOPE="read-only"
    META_FILE="${AGENTS_DIR}/${AGENT_TYPE}.meta.json"
    if [ -f "$META_FILE" ]; then
        ACCESS_SCOPE=$(jq -r '.["access-scope"] // "read-only"' "$META_FILE")
    fi

    # ── Derive hook flags from access scope ─────────────────────────────────
    case "$ACCESS_SCOPE" in
        read-only)
            HOOK_BUILD_INTERCEPT="false"
            HOOK_GIT_SYNC="false"
            WORKSPACE_READONLY="true"
            ;;
        write-access)
            HOOK_BUILD_INTERCEPT="false"
            HOOK_GIT_SYNC="true"
            WORKSPACE_READONLY="false"
            ;;
        ubt-build-hook-interceptor)
            HOOK_BUILD_INTERCEPT="true"
            HOOK_GIT_SYNC="false"
            WORKSPACE_READONLY="false"
            ;;
        *)
            HOOK_BUILD_INTERCEPT="false"
            HOOK_GIT_SYNC="true"
            WORKSPACE_READONLY="false"
            echo "WARNING: Unknown access-scope '$ACCESS_SCOPE', treating as write-access" >&2
            ;;
    esac

    # CLI override escape hatch (--hooks / --no-hooks via launch.sh)
    if [ "${HOOK_OVERRIDE:-}" = "all-on" ]; then
        HOOK_BUILD_INTERCEPT="true"
        HOOK_GIT_SYNC="false"
    elif [ "${HOOK_OVERRIDE:-}" = "all-off" ]; then
        HOOK_BUILD_INTERCEPT="false"
        HOOK_GIT_SYNC="false"
    fi

    # C++ lint is orthogonal to access scope
    HOOK_CPP_LINT="${HOOK_CPP_LINT:-false}"
    case "${HOOK_CPP_LINT}" in
      true|false) ;;
      *) echo "ERROR: HOOK_CPP_LINT must be 'true' or 'false', got '${HOOK_CPP_LINT}'" >&2; exit 1 ;;
    esac

    echo "Access scope: ${ACCESS_SCOPE} (buildIntercept=${HOOK_BUILD_INTERCEPT}, gitSync=${HOOK_GIT_SYNC}, readonly=${WORKSPACE_READONLY})"

    # Build the PreToolUse Bash matcher hooks array
    PRE_BASH=$(jq -n '[{"type":"command","command":"bash /claude-hooks/inject-agent-header.sh"}]')
    if [ "${HOOK_BUILD_INTERCEPT}" = "true" ]; then
        PRE_BASH=$(jq -n --argjson base "$PRE_BASH" \
            '[{"type":"command","command":"bash /claude-hooks/intercept_build_test.sh"},{"type":"command","command":"bash /claude-hooks/block-push-passthrough.sh"}] + $base')
    fi
    if [ "${WORKSPACE_READONLY}" = "false" ]; then
        PRE_BASH=$(jq -n --argjson base "$PRE_BASH" \
            '[{"type":"command","command":"bash /claude-hooks/guard-branch.sh"}] + $base')
    fi

    PRE_MATCHERS=$(jq -n --argjson hooks "$PRE_BASH" '[{"matcher":"Bash","hooks":$hooks}]')

    if [ "${HOOK_CPP_LINT}" = "true" ]; then
        PRE_MATCHERS=$(jq -n --argjson m "$PRE_MATCHERS" \
            '$m + [{"matcher":"Edit","hooks":[{"type":"command","command":"node /claude-hooks/lint-cpp-diff.mjs"}]},{"matcher":"Write","hooks":[{"type":"command","command":"node /claude-hooks/lint-cpp-diff.mjs"}]}]')
    fi

    POST_MATCHERS="[]"
    if [ "${HOOK_GIT_SYNC}" = "true" ]; then
        POST_MATCHERS=$(jq -n '[{"matcher":"Bash","hooks":[{"type":"command","command":"bash /claude-hooks/push-after-commit.sh"}]}]')
    fi

    # Write the final settings file
    jq -n --argjson pre "$PRE_MATCHERS" --argjson post "$POST_MATCHERS" \
        'if ($post | length) > 0 then {"hooks":{"PreToolUse":$pre,"PostToolUse":$post}} else {"hooks":{"PreToolUse":$pre}} end' \
        > /home/claude/.claude/settings.json

    echo "Hook settings: buildIntercept=${HOOK_BUILD_INTERCEPT}, cppLint=${HOOK_CPP_LINT}, gitSync=${HOOK_GIT_SYNC}"
    echo ""
    echo "── Resolved hook settings.json ──"
    cat /home/claude/.claude/settings.json
    echo ""
}

_setup_mcp_config() {
    # MCP config (written after registration so SESSION_TOKEN is available)
    if [ -n "${CHAT_ROOM:-}" ]; then
        cat > /home/claude/.claude/mcp.json <<MCPEOF
{
  "mcpServers": {
    "chat": {
      "command": "node",
      "args": ["/mcp-servers/chat-channel.mjs"],
      "env": {
        "SERVER_URL": "${SERVER_URL}",
        "AGENT_NAME": "${AGENT_NAME}",
        "SESSION_TOKEN": "${SESSION_TOKEN}"
      }
    }
  }
}
MCPEOF
        echo ""
        echo "── Resolved MCP config (chat mode) ──"
        cat /home/claude/.claude/mcp.json
        echo ""
    else
        cat > /home/claude/.claude/mcp.json <<MCPEOF
{
  "mcpServers": {}
}
MCPEOF
        echo ""
        echo "── MCP config: no chat channel (solo agent mode) ──"
        echo ""
    fi
}

_symlink_plugins() {
    # ── Symlink read-only plugin mounts ─────────────────────────────────────
    if [ -d /plugins-ro ]; then
        mkdir -p /workspace/Plugins
        for plugin_dir in /plugins-ro/*/; do
            [ -d "$plugin_dir" ] || continue
            plugin_name="$(basename "$plugin_dir")"
            # Reject traversal names
            if [[ -z "$plugin_name" || "$plugin_name" == "." || "$plugin_name" == ".." ]]; then
                echo "WARNING: skipping suspicious plugin directory name: '$plugin_dir'" >&2
                continue
            fi
            link="/workspace/Plugins/$plugin_name"
            if [ ! -e "$link" ]; then
                ln -sfn "$plugin_dir" "$link"
                echo "Symlinked $plugin_dir -> $link"
            fi
        done
    fi
}

_apply_readonly_lockdown() {
    # ── Read-only Source/ for non-leader design agents ──────────────────────
    if [ "${WORKSPACE_READONLY:-false}" = "true" ]; then
        if [ -d /workspace/Source ]; then
            echo "Locking down /workspace/Source/ (read-only design agent)"
            chmod -R a-w /workspace/Source 2>/dev/null || true
        fi
    fi
}

_print_diagnostics() {
    echo ""
    echo "── Pre-launch diagnostics ──"
    echo "Claude CLI version: $(claude --version 2>&1 || echo 'unknown')"
    echo "Container hostname: $(hostname)"
    echo "Working directory:  $(pwd)"
    echo "Git HEAD:           $(git -C /workspace log --oneline -1 2>/dev/null || echo 'N/A')"
    echo "Git branch:         $(git -C /workspace branch --show-current 2>/dev/null || echo 'N/A')"
    echo "Git commit count:   $(git -C /workspace rev-list --count HEAD 2>/dev/null || echo 'N/A')"
    echo ""
    echo "── Environment snapshot ──"
    echo "  AGENT_NAME=$AGENT_NAME"
    echo "  AGENT_TYPE=$AGENT_TYPE"
    echo "  AGENT_MODE=$AGENT_MODE"
    echo "  WORK_BRANCH=$WORK_BRANCH"
    echo "  MAX_TURNS=$MAX_TURNS"
    echo "  SERVER_URL=$SERVER_URL"
    echo "  PROJECT_ID=$PROJECT_ID"
    echo "  LOG_VERBOSITY=$LOG_VERBOSITY"
    echo "  WORKER_MODE=${WORKER_MODE:-false}"
    echo "  WORKER_SINGLE_TASK=$WORKER_SINGLE_TASK"
    echo "  WORKER_POLL_INTERVAL=$WORKER_POLL_INTERVAL"
    echo "  HOOK_BUILD_INTERCEPT=$HOOK_BUILD_INTERCEPT"
    echo "  HOOK_GIT_SYNC=$HOOK_GIT_SYNC"
    echo "  HOOK_CPP_LINT=$HOOK_CPP_LINT"
    echo "  WORKSPACE_READONLY=$WORKSPACE_READONLY"
    echo "  CHAT_ROOM=${CHAT_ROOM:-}"
    echo "  TEAM_ROLE=${TEAM_ROLE:-}"
    echo "  HOOK_OVERRIDE=${HOOK_OVERRIDE:-}"
    echo ""
}
