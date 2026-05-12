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

# Mode classification. FSM-dispatch containers (pump-loop or single-task
# daisy-chain) run multiple role sessions per task — engineer + reviewers +
# arbitrator — each with its own access-scope, all resolved from the project's
# agentRoles map at runtime. A single AGENT_TYPE has no coherent meaning here,
# so it must NOT be set. Non-FSM containers (DIRECT_PROMPT or chat-only TEAM)
# run a single agent for the lifetime of the container, so AGENT_TYPE is the
# sole identity and is required.
#
# Chat mode is signalled by CHAT_ROOM being set AND WORKER_MODE != "true";
# when WORKER_MODE is true the container is a worker that happens to also be
# a chat-room member, which still goes through FSM dispatch.
_is_fsm_mode() {
    [ -z "${DIRECT_PROMPT:-}" ] || return 1
    if [ -n "${CHAT_ROOM:-}" ] && [ "${WORKER_MODE:-false}" != "true" ]; then
        return 1
    fi
    return 0
}

if _is_fsm_mode; then
    if [ -n "$AGENT_TYPE" ]; then
        echo "ERROR: AGENT_TYPE='${AGENT_TYPE}' must not be set in FSM mode." >&2
        echo "  Per-role agents are resolved from agentRoles in scaffold.config.json." >&2
        echo "  Remove projects.<id>.agentType from scaffold.config.json and unset AGENT_TYPE in .env." >&2
        exit 1
    fi
else
    if [ -z "$AGENT_TYPE" ]; then
        echo "ERROR: AGENT_TYPE is required for --prompt / --team / chat mode containers." >&2
        exit 1
    fi
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
CURRENT_TASK_ID=""
CURRENT_TASK_TITLE=""
CURRENT_TASK_DESC=""
CURRENT_TASK_AC=""
CURRENT_TASK_SOURCE=""
CURRENT_TASK_FILES=""
CURRENT_SESSION_ID=""

# Reset all CURRENT_TASK_* variables to empty strings.
_reset_task_vars() {
    CURRENT_TASK_ID=""
    CURRENT_TASK_TITLE=""
    CURRENT_TASK_DESC=""
    CURRENT_TASK_AC=""
    CURRENT_TASK_SOURCE=""
    CURRENT_TASK_FILES=""
    CURRENT_SESSION_ID=""
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
