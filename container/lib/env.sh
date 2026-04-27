#!/bin/bash
# container/lib/env.sh — Environment variable defaults and validation.
# Sourced by entrypoint.sh; do not execute directly.

# ── Shared helpers ──────────────────────────────────────────────────────────
# Allowlist check: returns 0 if value matches ^[a-zA-Z0-9_-]+$, 1 otherwise.
_is_safe_name() {
    [[ "$1" =~ ^[a-zA-Z0-9_-]+$ ]]
}

WORK_BRANCH="${WORK_BRANCH:-main}"
AGENT_TYPE="${AGENT_TYPE:-}"
if [ -z "$AGENT_TYPE" ]; then
    echo "ERROR: AGENT_TYPE is not set. Every container must run a named agent." >&2
    exit 1
fi
AGENT_NAME="${AGENT_NAME:-agent-1}"
if ! _is_safe_name "$AGENT_NAME"; then
    echo "ERROR: AGENT_NAME contains invalid characters: $AGENT_NAME" >&2
    exit 1
fi
MAX_TURNS="${MAX_TURNS:-200}"
if [[ ! "$MAX_TURNS" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: MAX_TURNS must be a positive integer (>0): $MAX_TURNS" >&2
    exit 1
fi
SERVER_URL="${SERVER_URL:-http://host.docker.internal:9100}"
WORKER_POLL_INTERVAL="${WORKER_POLL_INTERVAL:-30}"
if [[ ! "$WORKER_POLL_INTERVAL" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: WORKER_POLL_INTERVAL must be a positive integer (>0): $WORKER_POLL_INTERVAL" >&2
    exit 1
fi
WORKER_SINGLE_TASK="${WORKER_SINGLE_TASK:-true}"
AGENT_MODE="${AGENT_MODE:-single}"
PROJECT_ID="${PROJECT_ID:-default}"
if ! _is_safe_name "$PROJECT_ID"; then
    echo "ERROR: PROJECT_ID contains invalid characters: $PROJECT_ID" >&2
    exit 1
fi
LOG_VERBOSITY="${LOG_VERBOSITY:-verbose}"
CLAUDE_OUTPUT_LOG="/tmp/claude-output.log"
HOST_LOG_DIR="/logs"
ABNORMAL_SHUTDOWN=""
ABNORMAL_REASON=""
CONSECUTIVE_ABNORMAL=0
# Number of consecutive task cycles that ended in any state other than 'completed'.
# Resets the moment any task reaches completed. At CONSECUTIVE_NONCOMPLETE_LIMIT
# the pump trips a circuit breaker and exits — covers degenerate loops where the
# container can claim tasks but never satisfy them (e.g. unfetchable agent type).
CONSECUTIVE_NONCOMPLETE=0
CONSECUTIVE_NONCOMPLETE_LIMIT=20
RECENT_NONCOMPLETE_TASK_IDS=()
CURRENT_TASK_ID=""
CURRENT_TASK_TITLE=""
CURRENT_TASK_DESC=""
CURRENT_TASK_AC=""
CURRENT_TASK_SOURCE=""
CURRENT_TASK_FILES=""
CURRENT_TASK_AGENT_TYPE=""

# Reset all CURRENT_TASK_* variables to empty strings.
_reset_task_vars() {
    CURRENT_TASK_ID=""
    CURRENT_TASK_TITLE=""
    CURRENT_TASK_DESC=""
    CURRENT_TASK_AC=""
    CURRENT_TASK_SOURCE=""
    CURRENT_TASK_FILES=""
    CURRENT_TASK_AGENT_TYPE=""
}

PUMP_STATUS=""
SESSION_TOKEN=""
AGENT_ID=""
AGENTS_DIR="/home/claude/.claude/agents"

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
