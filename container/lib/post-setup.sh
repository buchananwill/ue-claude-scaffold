#!/bin/bash
# container/lib/post-setup.sh — Post-registration setup: MCP config, diagnostics, lockdown.
# Sourced by entrypoint.sh; do not execute directly.
# These functions depend on registration having completed and SESSION_TOKEN being set.

_setup_mcp_config() {
    # MCP config (written after registration so SESSION_TOKEN is available)
    if [ -n "${CHAT_ROOM:-}" ]; then
        jq -n \
            --arg server_url "$SERVER_URL" \
            --arg agent_name "$AGENT_NAME" \
            --arg session_token "$SESSION_TOKEN" \
            --arg project_id "$PROJECT_ID" \
            '{
                "mcpServers": {
                    "chat": {
                        "command": "node",
                        "args": ["/mcp-servers/chat-channel.mjs"],
                        "env": {
                            "SERVER_URL": $server_url,
                            "AGENT_NAME": $agent_name,
                            "SESSION_TOKEN": $session_token,
                            "PROJECT_ID": $project_id
                        }
                    }
                }
            }' > /home/claude/.claude/mcp.json
        echo ""
        echo "MCP config written to /home/claude/.claude/mcp.json"
        echo ""
    else
        jq -n '{"mcpServers": {}}' > /home/claude/.claude/mcp.json
        echo ""
        echo "── MCP config: no chat channel (solo agent mode) ──"
        echo ""
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

_apply_readonly_lockdown() {
    # ── Read-only Source/ for non-leader design agents ──────────────────────
    if [ "${WORKSPACE_READONLY:-false}" = "true" ]; then
        if [ -d /workspace/Source ]; then
            echo "Locking down /workspace/Source/ (read-only design agent)"
            chmod -R a-w /workspace/Source 2>/dev/null || true
        fi
    fi
}
