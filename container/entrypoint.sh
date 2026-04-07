#!/bin/bash
set -euo pipefail

WORK_BRANCH="${WORK_BRANCH:-main}"
AGENT_TYPE="${AGENT_TYPE:-}"
if [ -z "$AGENT_TYPE" ]; then
    echo "ERROR: AGENT_TYPE is not set. Every container must run a named agent." >&2
    exit 1
fi
AGENT_NAME="${AGENT_NAME:-agent-1}"
MAX_TURNS="${MAX_TURNS:-200}"
SERVER_URL="${SERVER_URL:-http://host.docker.internal:9100}"
WORKER_POLL_INTERVAL="${WORKER_POLL_INTERVAL:-30}"
WORKER_SINGLE_TASK="${WORKER_SINGLE_TASK:-true}"
AGENT_MODE="${AGENT_MODE:-single}"
PROJECT_ID="${PROJECT_ID:-default}"
LOG_VERBOSITY="${LOG_VERBOSITY:-verbose}"
CLAUDE_OUTPUT_LOG="/tmp/claude-output.log"
HOST_LOG_DIR="/logs"
ABNORMAL_SHUTDOWN=""
CONSECUTIVE_ABNORMAL=0

# ── Persistent logging ─────────────────────────────────────────────────────
# Mirror ALL terminal output to a host-mounted log file (if /logs is mounted).
# The file survives container shutdown for forensic review.
CONTAINER_LOG=""
if [ -d "$HOST_LOG_DIR" ]; then
    CONTAINER_LOG="${HOST_LOG_DIR}/${AGENT_NAME}-$(date +%Y%m%d-%H%M%S).log"
    exec > >(tee -a "$CONTAINER_LOG") 2>&1
    echo "Logging to $CONTAINER_LOG"
fi

echo "=== Claude Code Docker Worker ==="
echo "Agent:  $AGENT_NAME"
echo "Branch: $WORK_BRANCH"
echo "Type:   $AGENT_TYPE"
echo "Turns:  $MAX_TURNS"
echo ""

# ── Clone from the local bare repo (bind-mounted at /repo.git) ──────────────

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

# ── Exclude Claude Code runtime metadata from git ────────────────────────────
# .claude/ stores conversation state, settings, etc. during operation.
# Exclude it so `git add -A` in the build hook only commits source code.
cat > .git/info/exclude <<'EXCL'
.claude/
EXCL

# ── Snapshot staged agents into container-local directory ─────────────────────
# Agent definitions are bind-mounted read-only at /staged-agents. Copy them to
# the working agents directory so the container owns its copy and is immune to
# external recompilation or deletion during the run.
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

# ── Set up Claude Code project settings ──────────────────────────────────────
# Install to user-level settings (not project-level) to keep them out of the
# git working tree entirely.  Claude Code merges user + project settings, so
# hooks defined here still apply to /workspace.

# ── Read access scope from compiler sidecar metadata ─────────────────────────
ACCESS_SCOPE="read-only"
META_FILE="${AGENTS_DIR}/${AGENT_TYPE}.meta.json"
if [ -f "$META_FILE" ]; then
    ACCESS_SCOPE=$(jq -r '.["access-scope"] // "read-only"' "$META_FILE")
fi

# ── Derive hook flags from access scope ──────────────────────────────────────
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

# C++ lint is orthogonal to access scope — driven by launch.sh hook cascade
HOOK_CPP_LINT="${HOOK_CPP_LINT:-false}"
case "${HOOK_CPP_LINT}" in
  true|false) ;;
  *) echo "ERROR: HOOK_CPP_LINT must be 'true' or 'false', got '${HOOK_CPP_LINT}'" >&2; exit 1 ;;
esac

echo "Access scope: ${ACCESS_SCOPE} (buildIntercept=${HOOK_BUILD_INTERCEPT}, gitSync=${HOOK_GIT_SYNC}, readonly=${WORKSPACE_READONLY})"

# Build the PreToolUse Bash matcher hooks array: inject-agent-header is always
# present; other hooks are prepended/appended when enabled.
PRE_BASH=$(jq -n '[{"type":"command","command":"bash /claude-hooks/inject-agent-header.sh"}]')
if [ "${HOOK_BUILD_INTERCEPT}" = "true" ]; then
    PRE_BASH=$(jq -n --argjson base "$PRE_BASH" \
        '[{"type":"command","command":"bash /claude-hooks/intercept_build_test.sh"},{"type":"command","command":"bash /claude-hooks/block-push-passthrough.sh"}] + $base')
fi
# Branch guard for any writable agent (write-access or higher)
if [ "${WORKSPACE_READONLY}" = "false" ]; then
    PRE_BASH=$(jq -n --argjson base "$PRE_BASH" \
        '[{"type":"command","command":"bash /claude-hooks/guard-branch.sh"}] + $base')
fi

# Start the PreToolUse matchers array with Bash
PRE_MATCHERS=$(jq -n --argjson hooks "$PRE_BASH" '[{"matcher":"Bash","hooks":$hooks}]')

# Append Edit and Write matchers for C++ linting when enabled
if [ "${HOOK_CPP_LINT}" = "true" ]; then
    PRE_MATCHERS=$(jq -n --argjson m "$PRE_MATCHERS" \
        '$m + [{"matcher":"Edit","hooks":[{"type":"command","command":"node /claude-hooks/lint-cpp-diff.mjs"}]},{"matcher":"Write","hooks":[{"type":"command","command":"node /claude-hooks/lint-cpp-diff.mjs"}]}]')
fi

# Build PostToolUse matchers: auto-push after commit for writable workspaces
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

# MCP config is written after agent registration (needs SESSION_TOKEN)

# ── Symlink read-only plugin mounts ──────────────────────────────────────────
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

# ── Register with coordination server ────────────────────────────────────────

# PROJECT_ID flows to the server via the X-Project-Id header here;
# the /agents/register route reads project_id from this header (not the JSON body).
_curl_server() {
    curl "$@" -H "X-Agent-Name: ${AGENT_NAME}" -H "X-Project-Id: ${PROJECT_ID}"
}

_post_status() {
    _curl_server -s -X POST "${SERVER_URL}/agents/${AGENT_NAME}/status" \
        -H "Content-Type: application/json" \
        -d "{\"status\": \"$1\"}" \
        --max-time 5 >/dev/null 2>&1 || true
}

_detect_abnormal_exit() {
    # Delegates exit classification to the coordination server.
    # Returns 0 (true) if abnormal, 1 (false) if clean.
    # Sets ABNORMAL_REASON to a human-readable description.
    local log_file="$1"
    [ -f "$log_file" ] || return 1

    local log_tail elapsed output_lines response
    log_tail="$(tail -200 "$log_file")"
    output_lines="$(wc -l < "$log_file")"

    if [ -n "${CLAUDE_START_TS:-}" ]; then
        local now
        now=$(date +%s)
        elapsed=$((now - CLAUDE_START_TS))
    else
        elapsed=9999
    fi

    # Build JSON payload using a tmpfile to avoid shell escaping issues
    local tmpfile
    tmpfile="$(mktemp)"
    python3 -c "
import json, sys
payload = {
    'logTail': sys.stdin.read(),
    'elapsedSeconds': int(sys.argv[1]),
    'outputLineCount': int(sys.argv[2]),
}
json.dump(payload, sys.stdout)
" "$elapsed" "$output_lines" < <(printf '%s' "$log_tail") > "$tmpfile" 2>/dev/null

    # If JSON encoding failed, fall back to not-abnormal
    if [ ! -s "$tmpfile" ]; then
        rm -f "$tmpfile"
        return 1
    fi

    response="$(_curl_server -s -X POST "${SERVER_URL}/agents/${AGENT_NAME}/exit:classify" \
        -H "Content-Type: application/json" \
        -d @"$tmpfile" \
        --max-time 10 2>/dev/null)" || {
        rm -f "$tmpfile"
        return 1
    }
    rm -f "$tmpfile"

    local is_abnormal
    is_abnormal="$(printf '%s' "$response" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('abnormal','false'))" 2>/dev/null)" || return 1

    if [ "$is_abnormal" = "True" ] || [ "$is_abnormal" = "true" ]; then
        ABNORMAL_REASON="$(printf '%s' "$response" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('reason','unknown'))" 2>/dev/null)" || ABNORMAL_REASON="unknown"
        return 0
    fi

    return 1
}

_post_abnormal_shutdown_message() {
    local reason="$1"
    local task_id="${2:-}"
    local tmpfile
    tmpfile=$(mktemp)
    cat > "$tmpfile" <<JSONEOF
{
    "channel": "general",
    "type": "abnormal_shutdown",
    "payload": {
        "agent": "${AGENT_NAME}",
        "reason": "${reason}",
        "taskId": "${task_id}",
        "message": "Agent ${AGENT_NAME} shut down abnormally: ${reason}. Claimed task released. Uncommitted work discarded. Manual restart required."
    }
}
JSONEOF
    _curl_server -s -X POST "${SERVER_URL}/messages" \
        -H "Content-Type: application/json" \
        -d @"$tmpfile" \
        --max-time 10 >/dev/null 2>&1 || true
    rm -f "$tmpfile"
}

_shutdown() {
    echo ""
    echo "=== Shutting down agent ${AGENT_NAME} ==="

    if [ -d /workspace/.git ]; then
        cd /workspace
        if [ -n "$ABNORMAL_SHUTDOWN" ]; then
            # Abnormal exit: discard uncommitted work (presumed invalid)
            echo "Abnormal shutdown — discarding uncommitted work"
            git checkout -- . 2>/dev/null || true
            git clean -fd 2>/dev/null || true
        else
            # Normal exit: commit and push remaining work
            git add -A 2>/dev/null || true
            git diff --cached --quiet 2>/dev/null || \
                git commit -m "Container shutdown commit" --no-gpg-sign 2>/dev/null || true
        fi
        git push origin "HEAD:${WORK_BRANCH}" --force 2>/dev/null || true
    fi

    # Release any claimed task back to pending
    if [ -n "${CURRENT_TASK_ID:-}" ]; then
        echo "Releasing task #${CURRENT_TASK_ID}..."
        _curl_server -s -X POST "${SERVER_URL}/tasks/${CURRENT_TASK_ID}/release" \
            --max-time 5 >/dev/null 2>&1 || true
    fi
    # Deregister the agent
    _curl_server -s -X DELETE "${SERVER_URL}/agents/${AGENT_NAME}" \
        --max-time 5 >/dev/null 2>&1 || true
}
trap _shutdown EXIT

_watch_for_stop() {
    local target_pid=$1
    while kill -0 "$target_pid" 2>/dev/null; do
        sleep 15
        local st
        st=$(_curl_server -sf "${SERVER_URL}/agents/${AGENT_NAME}" \
            --max-time 5 2>/dev/null | jq -r '.status // "unknown"') || st="unknown"
        if [ "$st" = "stopping" ]; then
            echo "Stop signal received — terminating Claude (pid $target_pid)"
            touch /tmp/.stop_requested
            kill -TERM "$target_pid" 2>/dev/null || true
            return
        fi
    done
}

CONTAINER_IP=$(hostname -i 2>/dev/null | awk '{print $1}') || CONTAINER_IP=""
REG_RESPONSE=$(_curl_server -s -w "\n%{http_code}" -X POST "${SERVER_URL}/agents/register" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"${AGENT_NAME}\", \"worktree\": \"${WORK_BRANCH}\", \"mode\": \"${AGENT_MODE}\", \"containerHost\": \"${CONTAINER_IP}\"}" \
    --max-time 10 2>/dev/null) || REG_RESPONSE=$'\n000'
REG_STATUS="${REG_RESPONSE##*$'\n'}"
REG_BODY="${REG_RESPONSE%$'\n'*}"

if [ "$REG_STATUS" != "200" ]; then
    echo "ERROR: Could not register with coordination server at ${SERVER_URL} (HTTP ${REG_STATUS})" >&2
    echo "Is the server running? Start it with: cd server && npm run dev" >&2
    exit 1
fi

SESSION_TOKEN=$(echo "$REG_BODY" | jq -r '.sessionToken // empty')
export SESSION_TOKEN
echo "Registered with coordination server (token: ${SESSION_TOKEN:0:8}...)"

# ── Smoke test: verify message board is reachable ───────────────────────────
SMOKE_RESPONSE=$(_curl_server -s -w "\n%{http_code}" -X POST "${SERVER_URL}/messages" \
    -H "Content-Type: application/json" \
    -d "{\"channel\":\"general\",\"type\":\"status_update\",\"payload\":{\"message\":\"Container online. Preparing to launch Claude agent.\"}}" \
    --max-time 10 2>/dev/null) || SMOKE_RESPONSE=$'\n000'
SMOKE_STATUS="${SMOKE_RESPONSE##*$'\n'}"
if [ "$SMOKE_STATUS" = "200" ] || [ "$SMOKE_STATUS" = "201" ]; then
    echo "Message board smoke test passed (HTTP ${SMOKE_STATUS})"
else
    echo "ERROR: Message board smoke test failed (HTTP ${SMOKE_STATUS})" >&2
    echo "Response: ${SMOKE_RESPONSE%$'\n'*}" >&2
    echo "The operator will have no visibility into agent progress. Aborting." >&2
    exit 1
fi

# Write MCP config (after registration so SESSION_TOKEN is available)
# Chat channel MCP is only mounted for team/chat mode — for solo agents it
# competes with the curl-based message board and confuses the agent.
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

# ── Pre-launch diagnostics ──────────────────────────────────────────────────
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

# ── Worker mode: poll and claim ──────────────────────────────────────────────

poll_and_claim_task() {
    local max_attempts=60
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        attempt=$((attempt + 1))

        # Stop detection: worst-case latency is one WORKER_POLL_INTERVAL (default 30s)
        # between the operator's DELETE and this check firing. The _watch_for_stop
        # watchdog (15s interval) only covers the period while Claude is actively running.
        local agent_st
        agent_st=$(_curl_server -sf "${SERVER_URL}/agents/${AGENT_NAME}" --max-time 5 2>/dev/null | jq -r '.status // "unknown"') || agent_st="unknown"
        if [ "$agent_st" = "stopping" ]; then
            echo "Stop signal received during task poll — shutting down."
            exit 0
        fi

        # Use claim-next endpoint — server picks the best task atomically
        local response
        response=$(_curl_server -s -w "\n%{http_code}" \
            -X POST "${SERVER_URL}/tasks/claim-next" \
            -H "Content-Type: application/json" \
            -d '{}' \
            --max-time 10) || response=$'\n000'
        local http_status="${response##*$'\n'}"
        local body="${response%$'\n'*}"

        if [ "$http_status" != "200" ]; then
            echo "claim-next request failed (HTTP ${http_status})"
            sleep "$WORKER_POLL_INTERVAL"
            continue
        fi

        local task_json
        task_json=$(echo "$body" | jq -r '.task // empty')

        if [ -n "$task_json" ] && [ "$task_json" != "null" ]; then
            CURRENT_TASK_ID=$(echo "$body" | jq -r '.task.id')
            CURRENT_TASK_TITLE=$(echo "$body" | jq -r '.task.title // "Untitled"')
            CURRENT_TASK_DESC=$(echo "$body" | jq -r '.task.description // ""')
            CURRENT_TASK_AC=$(echo "$body" | jq -r '.task.acceptanceCriteria // "None specified"')
            CURRENT_TASK_SOURCE=$(echo "$body" | jq -r '.task.sourcePath // ""')
            CURRENT_TASK_FILES=$(echo "$body" | jq -r '(.task.files // []) | join(", ")')
            echo "Claimed task #${CURRENT_TASK_ID}: ${CURRENT_TASK_TITLE}"
            echo ""
            echo "── Claimed task record ──"
            echo "$body" | jq '.task' 2>/dev/null || echo "$body"
            echo ""
            return 0
        fi

        # No task claimed — check why
        local pending blocked
        pending=$(echo "$body" | jq -r '.pending // 0')

        if [ "$pending" = "0" ]; then
            echo "No pending tasks remain. Pump complete."
            _post_status "done"
            return 1
        fi

        # Tasks exist but blocked by file ownership — wait for reconciliation
        blocked=$(echo "$body" | jq -r '.blocked // 0')
        _post_status "idle"
        echo "No claimable tasks (${pending} pending, ${blocked} blocked by file ownership). Waiting ${WORKER_POLL_INTERVAL}s... (${attempt}/${max_attempts})"
        sleep "$WORKER_POLL_INTERVAL"
    done

    echo "ERROR: No claimable tasks found after ${max_attempts} attempts"
    _post_status "error"
    return 1
}

# ── Assemble the task prompt ─────────────────────────────────────────────────
# Standing instructions have been superseded by the modular skills system.
# Each dynamic agent's compiled definition includes the skills it needs.
# The task prompt now contains only runtime context (verbosity, chat room,
# team role) and the task specification.

TASK_PROMPT=""

# Inject verbosity directive
TASK_PROMPT="${TASK_PROMPT}LOG_VERBOSITY: ${LOG_VERBOSITY}
"

# Inject chat room and team role if set
if [ -n "${CHAT_ROOM:-}" ]; then
    TASK_PROMPT="${TASK_PROMPT}CHAT_ROOM: ${CHAT_ROOM}
"
fi
if [ -n "${TEAM_ROLE:-}" ]; then
    TASK_PROMPT="${TASK_PROMPT}TEAM_ROLE: ${TEAM_ROLE}
"
fi

TASK_PROMPT="${TASK_PROMPT}
---

"

# ── Worker mode or static prompt ────────────────────────────────────────────

run_claude_task() {
    local FULL_PROMPT="$TASK_PROMPT"

    echo "Polling for tasks..."
    if ! poll_and_claim_task; then
        exit 1
    fi

    if [ -n "$CURRENT_TASK_SOURCE" ]; then
        # Plan mode: the sourcePath file IS the task specification.
        FULL_PROMPT="${FULL_PROMPT}TASK_ID: ${CURRENT_TASK_ID}
TASK_TITLE: ${CURRENT_TASK_TITLE}

Read the plan at \`${CURRENT_TASK_SOURCE}\` and carry out the work in accordance with your standard protocol.

The plan file is the complete specification — it contains all phases, file lists, and requirements. File ownership for this task: ${CURRENT_TASK_FILES:-none specified}."
    else
        # Inline mode: description + acceptance criteria from the task record.
        FULL_PROMPT="${FULL_PROMPT}TASK_ID: ${CURRENT_TASK_ID}
TASK_TITLE: ${CURRENT_TASK_TITLE}

## Task Description

${CURRENT_TASK_DESC}

## Acceptance Criteria

${CURRENT_TASK_AC}

File ownership for this task: ${CURRENT_TASK_FILES:-none specified}."
    fi

    echo "Task prompt assembled ($(echo -n "$FULL_PROMPT" | wc -c) bytes)"

    # ── Audit: dump full prompt text to log ─────────────────────────────────
    echo ""
    echo "╔══════════════════════════════════════════════════════════════════╗"
    echo "║                    FULL PROMPT TEXT                             ║"
    echo "╚══════════════════════════════════════════════════════════════════╝"
    echo "$FULL_PROMPT"
    echo "╔══════════════════════════════════════════════════════════════════╗"
    echo "║                  END FULL PROMPT TEXT                           ║"
    echo "╚══════════════════════════════════════════════════════════════════╝"
    echo ""

    echo "Starting Claude Code (agent: ${AGENT_TYPE:-default})..."
    echo ""

    # ── Run Claude Code ──────────────────────────────────────────────────────

    _post_status "working"

    # Build the claude command arguments.
    # --agent launches Claude directly AS the specified agent type, not as a
    # wrapper that delegates to it. This is critical: the orchestrator and
    # team roles need Agent tool access, which is unavailable to sub-agents.
    CLAUDE_ARGS=(
        -p "$FULL_PROMPT"
        --dangerously-skip-permissions
        --output-format text
        --max-turns "$MAX_TURNS"
        --mcp-config /home/claude/.claude/mcp.json
        --debug-file /logs/claude-debug.log
    )
    if [ -n "${CHAT_ROOM:-}" ]; then
        CLAUDE_ARGS+=(--channels server:chat --dangerously-load-development-channels server:chat)
    fi
    if [ -n "$AGENT_TYPE" ]; then
        CLAUDE_ARGS+=(--agent "$AGENT_TYPE")
    fi

    # Capture output for abnormal exit detection
    rm -f "$CLAUDE_OUTPUT_LOG"
    CLAUDE_START_TS=$(date +%s)

    set +e
    claude "${CLAUDE_ARGS[@]}" 2>&1 | tee "$CLAUDE_OUTPUT_LOG" &
    CLAUDE_PID=$!
    _watch_for_stop "$CLAUDE_PID" &
    WATCHDOG_PID=$!
    wait "$CLAUDE_PID" || true
    EXIT_CODE=$?
    kill "$WATCHDOG_PID" 2>/dev/null || true
    wait "$WATCHDOG_PID" 2>/dev/null || true
    set -e

    CLAUDE_END_TS=$(date +%s)
    CLAUDE_ELAPSED=$((CLAUDE_END_TS - CLAUDE_START_TS))

    echo ""
    echo "=== Claude Code exited with code $EXIT_CODE (wall-clock: ${CLAUDE_ELAPSED}s) ==="

    # Log output tail on non-zero exit for quick diagnosis
    if [ "$EXIT_CODE" -ne 0 ] && [ -f "$CLAUDE_OUTPUT_LOG" ]; then
        echo ""
        echo "── Last 30 lines of Claude output ──"
        tail -30 "$CLAUDE_OUTPUT_LOG"
        echo "── end tail ──"
    fi

    # If stopped externally, skip post-run flow and let the EXIT trap handle cleanup
    if [ -f /tmp/.stop_requested ]; then
        echo "Stopped by operator — skipping post-run status update"
        exit 0
    fi

    # ── Abnormal exit detection ─────────────────────────────────────────────
    # Token exhaustion and auth failures cause Claude to exit (often with code 0)
    # without completing any work. Detect this and release the task instead of
    # falsely marking it complete.
    if _detect_abnormal_exit "$CLAUDE_OUTPUT_LOG"; then
        echo "*** ABNORMAL EXIT DETECTED: ${ABNORMAL_REASON} ***"
        ABNORMAL_SHUTDOWN="true"

        # Discard uncommitted work (presumed invalid)
        cd /workspace
        git checkout -- . 2>/dev/null || true
        git clean -fd 2>/dev/null || true
        git push origin "HEAD:${WORK_BRANCH}" --force 2>/dev/null || true
        echo "Uncommitted work discarded. Branch preserved at last intentional commit."

        # Record the failure so the operator can see what happened
        _post_abnormal_shutdown_message "$ABNORMAL_REASON" "${CURRENT_TASK_ID:-}"

        # Release the task back to pending (not complete, not failed)
        if [ -n "$CURRENT_TASK_ID" ]; then
            echo "Releasing task #${CURRENT_TASK_ID} back to pending..."
            _curl_server -s -X POST "${SERVER_URL}/tasks/${CURRENT_TASK_ID}/release" \
                --max-time 10 >/dev/null 2>&1 || true
            CURRENT_TASK_ID=""  # Prevent _shutdown from double-releasing
        fi
        _post_status "error"

        return 1
    fi

    # ── Normal exit path ────────────────────────────────────────────────────
    # Final push — commit any uncommitted work, then push all commits to bare repo
    cd /workspace
    git add -A
    if ! git diff --cached --quiet; then
        git commit -m "Container final commit" --no-gpg-sign
    fi

    # Audit: log what the agent actually changed (diff from branch start)
    echo ""
    echo "── Git diff stats (cumulative changes on branch) ──"
    git diff --stat "origin/${WORK_BRANCH}" HEAD 2>/dev/null || echo "(could not compute diff stats)"
    echo "── Git log (commits this session) ──"
    git log --oneline "origin/${WORK_BRANCH}..HEAD" 2>/dev/null || echo "(could not compute log)"
    echo ""

    git push origin "HEAD:${WORK_BRANCH}" --force
    echo "Final state pushed to bare repo"

    # Report task completion
    if [ -n "$CURRENT_TASK_ID" ]; then
        if [ $EXIT_CODE -eq 0 ]; then
            _curl_server -s -X POST "${SERVER_URL}/tasks/${CURRENT_TASK_ID}/complete" \
                -H "Content-Type: application/json" \
                -d "{\"result\": {\"agent\": \"${AGENT_NAME}\", \"exitCode\": 0}}" \
                --max-time 10 >/dev/null 2>&1 || true
        else
            _curl_server -s -X POST "${SERVER_URL}/tasks/${CURRENT_TASK_ID}/fail" \
                -H "Content-Type: application/json" \
                -d "{\"error\": \"Claude exited with code ${EXIT_CODE}\"}" \
                --max-time 10 >/dev/null 2>&1 || true
        fi
    fi

    if [ $EXIT_CODE -eq 0 ]; then
        _post_status "done"
    else
        _post_status "error"
    fi

    return $EXIT_CODE
}

# ── Chat-only mode (design team agents) ──────────────────────────────────────

run_chat_agent() {
    local FULL_PROMPT="$TASK_PROMPT"

    FULL_PROMPT="${FULL_PROMPT}You are in chat room: ${CHAT_ROOM}
Your role: ${TEAM_ROLE:-participant}
Brief: \`${BRIEF_PATH:-BRIEF_PATH_NOT_SET}\` (read this file from your workspace to begin)

## YOUR TASK: Participate in a live design meeting

This is a MULTI-AGENT CONVERSATION. You are one of several agents in this room. Your job is NOT
a one-shot analysis — it is an ongoing, turn-based discussion mediated by the discussion leader.

1. Read the brief file from your workspace.
2. Post a SHORT hello (1-2 sentences) via the \`reply\` tool confirming your role and that you've read the brief.
3. Call \`check_messages\` to read the conversation. It returns ALL messages since your last reply as a structured log.
4. Respond to what you read using the \`reply\` tool.
5. Between responses, do your own research — read code, grep for patterns, investigate questions raised in discussion.
6. Call \`check_messages\` again. REPEAT steps 3-6 for the ENTIRE meeting.

## STAYING IN THE MEETING

Keep calling \`check_messages\` in a loop. If it returns 'No unread messages', wait ~15 seconds
(do research, read code), then call \`check_messages\` again. If no agent has sent a message for
longer than 60 seconds, send a check-in message via \`reply\` to keep the conversation alive.

All agents must remain in the meeting until the discussion leader posts DISCUSSION CONCLUDED."

    echo "Chat-only mode: room=${CHAT_ROOM}, role=${TEAM_ROLE:-participant}"
    echo "Prompt assembled ($(echo -n "$FULL_PROMPT" | wc -c) bytes)"

    # ── Audit: dump full prompt text to log ─────────────────────────────────
    echo ""
    echo "╔══════════════════════════════════════════════════════════════════╗"
    echo "║                    FULL PROMPT TEXT                             ║"
    echo "╚══════════════════════════════════════════════════════════════════╝"
    echo "$FULL_PROMPT"
    echo "╔══════════════════════════════════════════════════════════════════╗"
    echo "║                  END FULL PROMPT TEXT                           ║"
    echo "╚══════════════════════════════════════════════════════════════════╝"
    echo ""

    echo "Starting Claude Code..."
    echo ""

    # ── Run Claude Code ──────────────────────────────────────────────────────

    _post_status "working"

    # Capture output for abnormal exit detection
    rm -f "$CLAUDE_OUTPUT_LOG"
    CLAUDE_START_TS=$(date +%s)

    set +e
    claude -p "$FULL_PROMPT" \
        --dangerously-skip-permissions \
        --output-format text \
        --mcp-config /home/claude/.claude/mcp.json \
        --debug-file /logs/claude-debug.log \
        --channels server:chat \
        --dangerously-load-development-channels server:chat \
        --agent "$AGENT_TYPE" \
        2>&1 | tee "$CLAUDE_OUTPUT_LOG" &
    CLAUDE_PID=$!
    _watch_for_stop "$CLAUDE_PID" &
    WATCHDOG_PID=$!
    wait "$CLAUDE_PID" || true
    EXIT_CODE=$?
    kill "$WATCHDOG_PID" 2>/dev/null || true
    wait "$WATCHDOG_PID" 2>/dev/null || true
    set -e

    CLAUDE_END_TS=$(date +%s)
    CLAUDE_ELAPSED=$((CLAUDE_END_TS - CLAUDE_START_TS))

    echo ""
    echo "=== Claude Code exited with code $EXIT_CODE (wall-clock: ${CLAUDE_ELAPSED}s) ==="

    # Log output tail on non-zero exit for quick diagnosis
    if [ "$EXIT_CODE" -ne 0 ] && [ -f "$CLAUDE_OUTPUT_LOG" ]; then
        echo ""
        echo "── Last 30 lines of Claude output ──"
        tail -30 "$CLAUDE_OUTPUT_LOG"
        echo "── end tail ──"
    fi

    # If stopped externally, skip post-run flow and let the EXIT trap handle cleanup
    if [ -f /tmp/.stop_requested ]; then
        echo "Stopped by operator — skipping post-run status update"
        exit 0
    fi

    # ── Abnormal exit detection ─────────────────────────────────────────────
    if _detect_abnormal_exit "$CLAUDE_OUTPUT_LOG"; then
        echo "*** ABNORMAL EXIT DETECTED: ${ABNORMAL_REASON} ***"
        ABNORMAL_SHUTDOWN="true"
        _post_abnormal_shutdown_message "$ABNORMAL_REASON" ""
        _post_status "error"
        exit 1
    fi

    # Final push — commit any uncommitted work, then push all commits to bare repo
    cd /workspace
    git add -A
    if ! git diff --cached --quiet; then
        git commit -m "Container final commit" --no-gpg-sign
    fi

    # Audit: log what the agent actually changed
    echo ""
    echo "── Git diff stats (cumulative changes on branch) ──"
    git diff --stat "origin/${WORK_BRANCH}" HEAD 2>/dev/null || echo "(could not compute diff stats)"
    echo "── Git log (commits this session) ──"
    git log --oneline "origin/${WORK_BRANCH}..HEAD" 2>/dev/null || echo "(could not compute log)"
    echo ""

    git push origin "HEAD:${WORK_BRANCH}" --force
    echo "Final state pushed to bare repo"

    if [ $EXIT_CODE -eq 0 ]; then
        _post_status "done"
    else
        _post_status "error"
    fi

    return $EXIT_CODE
}

# ── Read-only Source/ for non-leader design agents ───────────────────────────
# Runs after all workspace setup (clone, checkout, symlinks, plugin patching)
# so it doesn't break symlinks, .claude/, plans/, or temp files.
if [ "${WORKSPACE_READONLY:-false}" = "true" ]; then
    if [ -d /workspace/Source ]; then
        echo "Locking down /workspace/Source/ (read-only design agent)"
        chmod -R a-w /workspace/Source 2>/dev/null || true
    fi
fi

# ── Main execution loop ─────────────────────────────────────────────────────

# ── Direct prompt mode (troubleshooting / smoke tests) ──────────────────────
if [ -n "${DIRECT_PROMPT:-}" ]; then
    echo "Direct prompt mode: bypassing task queue"
    echo "Prompt: ${DIRECT_PROMPT}"
    echo ""

    _post_status "working"

    CLAUDE_ARGS=(
        -p "$DIRECT_PROMPT"
        --dangerously-skip-permissions
        --output-format text
        --max-turns "$MAX_TURNS"
        --mcp-config /home/claude/.claude/mcp.json
        --debug-file /logs/claude-debug.log
    )
    if [ -n "${CHAT_ROOM:-}" ]; then
        CLAUDE_ARGS+=(--channels server:chat --dangerously-load-development-channels server:chat)
    fi
    if [ -n "$AGENT_TYPE" ]; then
        CLAUDE_ARGS+=(--agent "$AGENT_TYPE")
    fi

    rm -f "$CLAUDE_OUTPUT_LOG"
    CLAUDE_START_TS=$(date +%s)

    set +e
    claude "${CLAUDE_ARGS[@]}" 2>&1 | tee "$CLAUDE_OUTPUT_LOG" &
    CLAUDE_PID=$!
    _watch_for_stop "$CLAUDE_PID" &
    WATCHDOG_PID=$!
    wait "$CLAUDE_PID" || true
    EXIT_CODE=$?
    kill "$WATCHDOG_PID" 2>/dev/null || true
    wait "$WATCHDOG_PID" 2>/dev/null || true
    set -e

    echo ""
    echo "=== Claude Code exited with code $EXIT_CODE ==="

    if [ $EXIT_CODE -eq 0 ]; then
        _post_status "done"
    else
        _post_status "error"
    fi
    exit $EXIT_CODE
fi

# ── Chat-only mode (design team agents) ──────────────────────────────────────
if [ -n "${CHAT_ROOM:-}" ] && [ "${WORKER_MODE:-false}" = "false" ]; then
    run_chat_agent
    exit $?
fi

if [ "$WORKER_SINGLE_TASK" = "false" ]; then
    # Multi-task pump loop with circuit breaker
    while true; do
        ABNORMAL_SHUTDOWN=""  # Reset per-task

        set +e
        run_claude_task
        TASK_EXIT=$?
        set -e

        # ── Circuit breaker: stop the pump after consecutive abnormal exits ──
        if [ -n "$ABNORMAL_SHUTDOWN" ]; then
            CONSECUTIVE_ABNORMAL=$((CONSECUTIVE_ABNORMAL + 1))
            echo "*** Abnormal exit #${CONSECUTIVE_ABNORMAL}: ${ABNORMAL_REASON:-unknown} ***"
            if [ "$CONSECUTIVE_ABNORMAL" -ge 2 ]; then
                echo "*** CIRCUIT BREAKER: ${CONSECUTIVE_ABNORMAL} consecutive abnormal exits. ***"
                echo "*** Stopping pump. Manual intervention required. ***"
                _post_status "error"
                exit 1
            fi
            echo "Will retry once more before triggering circuit breaker."
        else
            CONSECUTIVE_ABNORMAL=0
        fi

        # Clean workspace for next task
        cd /workspace
        git fetch origin 2>/dev/null || true
        git reset --hard "origin/${WORK_BRANCH}" 2>/dev/null || git reset --hard HEAD
        git clean -fd

        # Reset task-specific variables
        CURRENT_TASK_ID=""
        CURRENT_TASK_TITLE=""
        CURRENT_TASK_DESC=""
        CURRENT_TASK_AC=""
        CURRENT_TASK_SOURCE=""
        CURRENT_TASK_FILES=""

        # Check if agent has been paused
        AGENT_STATUS=$(_curl_server -sf "${SERVER_URL}/agents/${AGENT_NAME}" \
            --max-time 5 2>/dev/null | jq -r '.status // "unknown"') || AGENT_STATUS="unknown"
        if [ "$AGENT_STATUS" = "stopping" ]; then
            echo "Agent deregistered — shutting down."
            exit 0
        fi

        if [ "$AGENT_STATUS" = "paused" ]; then
            echo "Agent is paused. Waiting for resume..."
            while true; do
                sleep "$WORKER_POLL_INTERVAL"
                AGENT_STATUS=$(_curl_server -sf "${SERVER_URL}/agents/${AGENT_NAME}" \
                    --max-time 5 2>/dev/null | jq -r '.status // "unknown"') || AGENT_STATUS="unknown"
                if [ "$AGENT_STATUS" = "stopping" ]; then
                    echo "Agent deregistered — shutting down."
                    exit 0
                fi
                if [ "$AGENT_STATUS" != "paused" ]; then
                    echo "Agent resumed (status: ${AGENT_STATUS})."
                    break
                fi
            done
        fi

        echo ""
        echo "=== Task complete (exit $TASK_EXIT). Polling for next task... ==="
        echo ""
    done
else
    # Single task (static or worker mode with WORKER_SINGLE_TASK=true)
    run_claude_task
    exit $?
fi
