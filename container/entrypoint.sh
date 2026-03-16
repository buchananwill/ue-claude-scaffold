#!/bin/bash
set -euo pipefail

WORK_BRANCH="${WORK_BRANCH:-main}"
TASK_PROMPT_FILE="${TASK_PROMPT_FILE:-/task/prompt.md}"
AGENT_TYPE="${AGENT_TYPE:-container-orchestrator}"
AGENT_NAME="${AGENT_NAME:-agent-1}"
MAX_TURNS="${MAX_TURNS:-200}"
SERVER_URL="${SERVER_URL:-http://host.docker.internal:9100}"

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

curl -s -X POST "${SERVER_URL}/agents/register" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Name: ${AGENT_NAME}" \
    -d "{\"name\": \"${AGENT_NAME}\", \"worktree\": \"${WORK_BRANCH}\"}" \
    --max-time 5 >/dev/null 2>&1 || echo "Warning: Could not register with server at ${SERVER_URL}"

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

if [ ! -f "$TASK_PROMPT_FILE" ]; then
    echo "ERROR: Task prompt file not found: $TASK_PROMPT_FILE"
    _post_status "error"
    exit 1
fi

TASK_PROMPT="${TASK_PROMPT}$(cat "$TASK_PROMPT_FILE")"

# If an agent type is specified, wrap the prompt so the top-level Claude
# immediately delegates to that agent.
if [ -n "$AGENT_TYPE" ]; then
    TASK_PROMPT="Use the ${AGENT_TYPE} agent to carry out the following task. Launch it immediately — do not do any work yourself, delegate everything to the agent.

---

${TASK_PROMPT}"
fi

echo "Task prompt assembled ($(echo -n "$TASK_PROMPT" | wc -c) bytes)"
echo ""
echo "Starting Claude Code..."
echo ""

# ── Run Claude Code ──────────────────────────────────────────────────────────

_post_status "working"

claude -p "$TASK_PROMPT" \
    --dangerously-skip-permissions \
    --output-format text \
    --max-turns "$MAX_TURNS" \
    2>&1

EXIT_CODE=$?

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

if [ $EXIT_CODE -eq 0 ]; then
    _post_status "done"
else
    _post_status "error"
fi

exit $EXIT_CODE
