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

REG_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${SERVER_URL}/agents/register" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Name: ${AGENT_NAME}" \
    -d "{\"name\": \"${AGENT_NAME}\", \"worktree\": \"${WORK_BRANCH}\"}" \
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

        TASK_JSON=$(curl -sf "${SERVER_URL}/tasks?status=pending&limit=1" \
            --max-time 10 2>/dev/null) || TASK_JSON="[]"

        TASK_COUNT=$(echo "$TASK_JSON" | jq 'length')

        if [ "$TASK_COUNT" -gt 0 ]; then
            CURRENT_TASK_ID=$(echo "$TASK_JSON" | jq -r '.[0].id')
            CURRENT_TASK_TITLE=$(echo "$TASK_JSON" | jq -r '.[0].title // "Untitled"')
            CURRENT_TASK_DESC=$(echo "$TASK_JSON" | jq -r '.[0].description // ""')
            CURRENT_TASK_AC=$(echo "$TASK_JSON" | jq -r '.[0].acceptanceCriteria // "None specified"')

            # Try to claim it
            CLAIM_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
                -X POST "${SERVER_URL}/tasks/${CURRENT_TASK_ID}/claim" \
                -H "X-Agent-Name: ${AGENT_NAME}" \
                --max-time 10)

            if [ "$CLAIM_STATUS" = "200" ]; then
                echo "Claimed task #${CURRENT_TASK_ID}: ${CURRENT_TASK_TITLE}"
                return 0
            else
                echo "Task #${CURRENT_TASK_ID} already claimed, retrying..."
                sleep 1
                continue
            fi
        fi

        _post_status "idle"
        echo "No pending tasks. Polling again in ${WORKER_POLL_INTERVAL}s... (attempt ${attempt}/${max_attempts})"
        sleep "$WORKER_POLL_INTERVAL"
    done

    echo "ERROR: No tasks found after ${max_attempts} attempts"
    _post_status "error"
    return 1
}

# ── Assemble the task prompt ─────────────────────────────────────────────────
# Standing instructions from /task/instructions/*.md are prepended (sorted by
# filename) before the main task prompt.

TASK_PROMPT=""

INSTRUCTIONS_DIR="/task/instructions"
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
        2>&1
    EXIT_CODE=$?
    set -e

    echo ""
    echo "=== Claude Code exited with code $EXIT_CODE ==="

    # Final push of any uncommitted work
    cd /workspace
    git add -A
    if ! git diff --cached --quiet; then
        git commit -m "Container final commit" --no-gpg-sign
        git push origin "HEAD:${WORK_BRANCH}" --force
        echo "Final changes pushed to bare repo"
    fi

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

        echo ""
        echo "=== Task complete (exit $TASK_EXIT). Polling for next task... ==="
        echo ""
    done
else
    # Single task (static or worker mode with WORKER_SINGLE_TASK=true)
    run_claude_task
    exit $?
fi
