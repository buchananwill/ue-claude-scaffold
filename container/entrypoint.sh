#!/bin/bash
set -euo pipefail

WORK_BRANCH="${WORK_BRANCH:-main}"
TASK_PROMPT_FILE="${TASK_PROMPT_FILE:-/task/prompt.md}"
AGENT_TYPE="${AGENT_TYPE:-container-orchestrator}"
AGENT_NAME="${AGENT_NAME:-agent-1}"
MAX_TURNS="${MAX_TURNS:-200}"
SERVER_URL="${SERVER_URL:-http://host.docker.internal:9100}"
WORKER_MODE="${WORKER_MODE:-false}"
WORKER_POLL_INTERVAL="${WORKER_POLL_INTERVAL:-30}"
WORKER_SINGLE_TASK="${WORKER_SINGLE_TASK:-true}"
AGENT_MODE="${AGENT_MODE:-single}"
LOG_VERBOSITY="${LOG_VERBOSITY:-normal}"

echo "=== Claude Code Docker Worker ==="
echo "Agent:  $AGENT_NAME"
echo "Branch: $WORK_BRANCH"
echo "Task:   $TASK_PROMPT_FILE"
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

# ── Set up Claude Code project settings ──────────────────────────────────────

mkdir -p /workspace/.claude
cp /container-settings.json /workspace/.claude/settings.json

# ── Patch workspace for container environment ────────────────────────────────
# Remaps paths, substitutes agents, symlinks plugins.
# Skipped if the patch script doesn't exist or there's no CLAUDE.md.

if [ -f /patch_workspace.py ] && [ -f /workspace/CLAUDE.md ]; then
    python3 /patch_workspace.py
    # Mark patched files as unchanged so git add -A never commits the
    # container-specific patches (path remaps, stripped sections, etc.)
    git update-index --assume-unchanged CLAUDE.md 2>/dev/null || true
    git update-index --assume-unchanged .claude/CLAUDE.md 2>/dev/null || true
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

REG_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${SERVER_URL}/agents/register" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Name: ${AGENT_NAME}" \
    -d "{\"name\": \"${AGENT_NAME}\", \"worktree\": \"${WORK_BRANCH}\", \"mode\": \"${AGENT_MODE}\"}" \
    --max-time 10 2>/dev/null) || REG_STATUS="000"

if [ "$REG_STATUS" != "200" ]; then
    echo "ERROR: Could not register with coordination server at ${SERVER_URL} (HTTP ${REG_STATUS})" >&2
    echo "Is the server running? Start it with: cd server && npm run dev" >&2
    exit 1
fi
echo "Registered with coordination server."

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
        echo "Loading instruction: $(basename "$f")"
        TASK_PROMPT="${TASK_PROMPT}$(cat "$f")

---

"
    done
fi

# Inject verbosity directive
TASK_PROMPT="${TASK_PROMPT}LOG_VERBOSITY: ${LOG_VERBOSITY}

---

"

# ── Worker mode or static prompt ────────────────────────────────────────────

run_claude_task() {
    local FULL_PROMPT="$TASK_PROMPT"

    if [ "$WORKER_MODE" = "true" ]; then
        echo "Worker mode: polling for tasks..."
        if ! poll_and_claim_task; then
            exit 1
        fi

        FULL_PROMPT="${FULL_PROMPT}TASK_ID: ${CURRENT_TASK_ID}
TASK_TITLE: ${CURRENT_TASK_TITLE}

## Task Description

${CURRENT_TASK_DESC}

## Acceptance Criteria

${CURRENT_TASK_AC}"
    else
        # Existing static prompt assembly
        if [ ! -f "$TASK_PROMPT_FILE" ]; then
            echo "ERROR: Task prompt file not found: $TASK_PROMPT_FILE"
            _post_status "error"
            exit 1
        fi
        FULL_PROMPT="${FULL_PROMPT}$(cat "$TASK_PROMPT_FILE")"
    fi

    # If an agent type is specified, wrap the prompt so the top-level Claude
    # immediately delegates to that agent.
    if [ -n "$AGENT_TYPE" ]; then
        FULL_PROMPT="Use the ${AGENT_TYPE} agent to carry out the following task. Launch it immediately — do not do any work yourself, delegate everything to the agent.

---

${FULL_PROMPT}"
    fi

    echo "Task prompt assembled ($(echo -n "$FULL_PROMPT" | wc -c) bytes)"
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

    # ── Report task completion (worker mode) ──────────────────────────────────
    if [ "$WORKER_MODE" = "true" ] && [ -n "$CURRENT_TASK_ID" ]; then
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

# ── Main execution loop ─────────────────────────────────────────────────────

if [ "$WORKER_MODE" = "true" ] && [ "$WORKER_SINGLE_TASK" = "false" ]; then
    # Multi-task worker loop
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
