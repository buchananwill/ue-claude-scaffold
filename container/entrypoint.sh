#!/bin/bash
set -euo pipefail

WORK_BRANCH="${WORK_BRANCH:-main}"
AGENT_TYPE="${AGENT_TYPE:-container-orchestrator}"
AGENT_NAME="${AGENT_NAME:-agent-1}"
MAX_TURNS="${MAX_TURNS:-200}"
SERVER_URL="${SERVER_URL:-http://host.docker.internal:9100}"
WORKER_POLL_INTERVAL="${WORKER_POLL_INTERVAL:-30}"
WORKER_SINGLE_TASK="${WORKER_SINGLE_TASK:-true}"
AGENT_MODE="${AGENT_MODE:-single}"
LOG_VERBOSITY="${LOG_VERBOSITY:-normal}"

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

# ── Set up Claude Code project settings ──────────────────────────────────────
# Install to user-level settings (not project-level) to keep them out of the
# git working tree entirely.  Claude Code merges user + project settings, so
# hooks defined here still apply to /workspace.

if [ "${DISABLE_BUILD_HOOKS:-false}" = "true" ]; then
    echo "Build hooks disabled (design agent mode)"
    cat > /home/claude/.claude/settings.json <<'SETTINGSEOF'
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash /claude-hooks/inject-agent-header.sh"
          }
        ]
      }
    ]
  }
}
SETTINGSEOF
else
    cp /container-settings.json /home/claude/.claude/settings.json
fi

# MCP config is written after agent registration (needs SESSION_TOKEN)

# ── Symlink read-only plugin mounts ──────────────────────────────────────────
if [ -f /patch_workspace.py ] && [ -d /plugins-ro ]; then
    python3 /patch_workspace.py
fi

# ── Register with coordination server ────────────────────────────────────────

_post_status() {
    curl -s -X POST "${SERVER_URL}/agents/${AGENT_NAME}/status" \
        -H "Content-Type: application/json" \
        -H "X-Agent-Name: ${AGENT_NAME}" \
        -d "{\"status\": \"$1\"}" \
        --max-time 5 >/dev/null 2>&1 || true
}

_shutdown() {
    echo ""
    echo "=== Shutting down agent ${AGENT_NAME} ==="
    # Push any remaining work to bare repo
    if [ -d /workspace/.git ]; then
        cd /workspace
        git add -A 2>/dev/null || true
        git diff --cached --quiet 2>/dev/null || \
            git commit -m "Container shutdown commit" --no-gpg-sign 2>/dev/null || true
        git push origin "HEAD:${WORK_BRANCH}" --force 2>/dev/null || true
    fi
    # Release any claimed task back to pending
    if [ -n "${CURRENT_TASK_ID:-}" ]; then
        echo "Releasing task #${CURRENT_TASK_ID}..."
        curl -s -X POST "${SERVER_URL}/tasks/${CURRENT_TASK_ID}/release" \
            --max-time 5 >/dev/null 2>&1 || true
    fi
    # Deregister the agent
    curl -s -X DELETE "${SERVER_URL}/agents/${AGENT_NAME}" \
        --max-time 5 >/dev/null 2>&1 || true
}
trap _shutdown EXIT

_watch_for_stop() {
    local target_pid=$1
    while kill -0 "$target_pid" 2>/dev/null; do
        sleep 15
        local st
        st=$(curl -sf "${SERVER_URL}/agents/${AGENT_NAME}" \
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
REG_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${SERVER_URL}/agents/register" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Name: ${AGENT_NAME}" \
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

# Write MCP config for chat channel (after registration so SESSION_TOKEN is available)
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
        agent_st=$(curl -sf "${SERVER_URL}/agents/${AGENT_NAME}" --max-time 5 2>/dev/null | jq -r '.status // "unknown"') || agent_st="unknown"
        if [ "$agent_st" = "stopping" ]; then
            echo "Stop signal received during task poll — shutting down."
            exit 0
        fi

        # Use claim-next endpoint — server picks the best task atomically
        local response
        response=$(curl -s -w "\n%{http_code}" \
            -X POST "${SERVER_URL}/tasks/claim-next" \
            -H "Content-Type: application/json" \
            -H "X-Agent-Name: ${AGENT_NAME}" \
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
# Standing instructions from /task/instructions/*.md are prepended (sorted by
# filename) before the main task prompt.

TASK_PROMPT=""

INSTRUCTIONS_DIR="/standing-instructions"
if [ -d "$INSTRUCTIONS_DIR" ]; then
    for f in $(find "$INSTRUCTIONS_DIR" -maxdepth 1 -name '*.md' | sort); do
        # Chat-only agents only load the chat protocol instruction
        if [ -n "${CHAT_ROOM:-}" ] && [ "${WORKER_MODE:-false}" = "false" ]; then
            case "$(basename "$f")" in
                *chat*) ;;  # load it
                *) echo "Skipping instruction (chat-only mode): $(basename "$f")"; continue ;;
            esac
        fi
        echo "Loading instruction: $(basename "$f")"
        TASK_PROMPT="${TASK_PROMPT}$(cat "$f")

---

"
    done
fi

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
        --channels server:chat
        --dangerously-load-development-channels server:chat
    )
    if [ -n "$AGENT_TYPE" ]; then
        CLAUDE_ARGS+=(--agent "$AGENT_TYPE")
    fi

    set +e
    claude "${CLAUDE_ARGS[@]}" 2>&1 &
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

    # If stopped externally, skip post-run flow and let the EXIT trap handle cleanup
    if [ -f /tmp/.stop_requested ]; then
        echo "Stopped by operator — skipping post-run status update"
        exit 0
    fi

    # Final push — commit any uncommitted work, then push all commits to bare repo
    cd /workspace
    git add -A
    if ! git diff --cached --quiet; then
        git commit -m "Container final commit" --no-gpg-sign
    fi
    git push origin "HEAD:${WORK_BRANCH}" --force
    echo "Final state pushed to bare repo"

    # ── Report task completion ──────────────────────────────────────────────
    if [ -n "$CURRENT_TASK_ID" ]; then
        if [ $EXIT_CODE -eq 0 ]; then
            curl -s -X POST "${SERVER_URL}/tasks/${CURRENT_TASK_ID}/complete" \
                -H "Content-Type: application/json" \
                -H "X-Agent-Name: ${AGENT_NAME}" \
                -d "{\"result\": {\"agent\": \"${AGENT_NAME}\", \"exitCode\": 0}}" \
                --max-time 10 >/dev/null 2>&1 || true
        else
            curl -s -X POST "${SERVER_URL}/tasks/${CURRENT_TASK_ID}/fail" \
                -H "Content-Type: application/json" \
                -H "X-Agent-Name: ${AGENT_NAME}" \
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

    FULL_PROMPT="${FULL_PROMPT}You are joining a LIVE DESIGN MEETING in chat room: ${CHAT_ROOM}
Your role: ${TEAM_ROLE:-participant}

Read the brief at \`${BRIEF_PATH:-BRIEF_PATH_NOT_SET}\` in your workspace. Then post a SHORT hello (1-2 sentences) confirming your role and that you've read the brief. Then WAIT for the chairman to open discussion.

This is a LONG-RUNNING CONVERSATION. Other team members are in parallel containers and will send messages after you. Messages arrive as channel events. You MUST stay active and respond to each event. Do NOT exit after your first message — the meeting is not over until the chairman concludes it.

Use the \`reply\` MCP tool to send messages (room, content, optional replyTo). Do NOT use curl or Bash.

Keep messages to 1-3 sentences unless the chairman invites you to elaborate."

    echo "Chat-only mode: room=${CHAT_ROOM}, role=${TEAM_ROLE:-participant}"
    echo "Prompt assembled ($(echo -n "$FULL_PROMPT" | wc -c) bytes)"
    echo ""
    echo "Starting Claude Code..."
    echo ""

    # ── Run Claude Code ──────────────────────────────────────────────────────

    _post_status "working"

    set +e
    claude -p "$FULL_PROMPT" \
        --dangerously-skip-permissions \
        --output-format text \
        --max-turns "$MAX_TURNS" \
        --mcp-config /home/claude/.claude/mcp.json \
        --channels server:chat \
        --dangerously-load-development-channels server:chat \
        2>&1 &
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

    # If stopped externally, skip post-run flow and let the EXIT trap handle cleanup
    if [ -f /tmp/.stop_requested ]; then
        echo "Stopped by operator — skipping post-run status update"
        exit 0
    fi

    # Final push — commit any uncommitted work, then push all commits to bare repo
    cd /workspace
    git add -A
    if ! git diff --cached --quiet; then
        git commit -m "Container final commit" --no-gpg-sign
    fi
    git push origin "HEAD:${WORK_BRANCH}" --force
    echo "Final state pushed to bare repo"

    if [ $EXIT_CODE -eq 0 ]; then
        _post_status "done"
    else
        _post_status "error"
    fi

    return $EXIT_CODE
}

# ── Read-only Source/ for non-chairman design agents ─────────────────────────
# Runs after all workspace setup (clone, checkout, symlinks, plugin patching)
# so it doesn't break symlinks, .claude/, plans/, or temp files.
if [ "${WORKSPACE_READONLY:-false}" = "true" ]; then
    if [ -d /workspace/Source ]; then
        echo "Locking down /workspace/Source/ (read-only design agent)"
        chmod -R a-w /workspace/Source 2>/dev/null || true
    fi
fi

# ── Main execution loop ─────────────────────────────────────────────────────

# ── Chat-only mode (design team agents) ──────────────────────────────────────
if [ -n "${CHAT_ROOM:-}" ] && [ "${WORKER_MODE:-false}" = "false" ]; then
    run_chat_agent
    exit $?
fi

if [ "$WORKER_SINGLE_TASK" = "false" ]; then
    # Multi-task pump loop
    while true; do
        set +e
        run_claude_task
        TASK_EXIT=$?
        set -e

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
        AGENT_STATUS=$(curl -sf "${SERVER_URL}/agents/${AGENT_NAME}" \
            --max-time 5 2>/dev/null | jq -r '.status // "unknown"') || AGENT_STATUS="unknown"
        if [ "$AGENT_STATUS" = "stopping" ]; then
            echo "Agent deregistered — shutting down."
            exit 0
        fi

        if [ "$AGENT_STATUS" = "paused" ]; then
            echo "Agent is paused. Waiting for resume..."
            while true; do
                sleep "$WORKER_POLL_INTERVAL"
                AGENT_STATUS=$(curl -sf "${SERVER_URL}/agents/${AGENT_NAME}" \
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
