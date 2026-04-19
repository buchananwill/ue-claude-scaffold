#!/bin/bash
set -euo pipefail

# ── Source library modules ──────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/env.sh
source "${SCRIPT_DIR}/lib/env.sh"

# shellcheck source=lib/registration.sh
source "${SCRIPT_DIR}/lib/registration.sh"

# shellcheck source=lib/workspace-setup.sh
source "${SCRIPT_DIR}/lib/workspace-setup.sh"

# shellcheck source=lib/finalize.sh
source "${SCRIPT_DIR}/lib/finalize.sh"

# shellcheck source=lib/run-claude.sh
source "${SCRIPT_DIR}/lib/run-claude.sh"

# shellcheck source=lib/post-setup.sh
source "${SCRIPT_DIR}/lib/post-setup.sh"

# shellcheck source=lib/agent-fetch.sh
source "${SCRIPT_DIR}/lib/agent-fetch.sh"

# shellcheck source=lib/pump-loop.sh
source "${SCRIPT_DIR}/lib/pump-loop.sh"

# ── Workspace setup ────────────────────────────────────────────────────────
_setup_workspace
_snapshot_agents
_setup_hooks
_symlink_plugins

# ── Register with coordination server ──────────────────────────────────────
_register_agent
_smoke_test_messages
trap _shutdown EXIT

# ── Post-registration setup ────────────────────────────────────────────────
_setup_mcp_config
_print_diagnostics
_apply_readonly_lockdown

# ── Main dispatch ──────────────────────────────────────────────────────────

# Direct prompt mode (troubleshooting / smoke tests)
if [ -n "${DIRECT_PROMPT:-}" ]; then
    echo "Direct prompt mode: bypassing task queue"
    echo "Prompt: ${DIRECT_PROMPT}"
    echo ""
    _run_claude "$DIRECT_PROMPT" "direct"
    exit $?
fi

# Chat-only mode (design team agents)
if [ -n "${CHAT_ROOM:-}" ] && [ "${WORKER_MODE:-false}" = "false" ]; then
    chat_prompt="$(_build_chat_prompt)"
    echo "Chat-only mode: room=${CHAT_ROOM}, role=${TEAM_ROLE:-participant}"
    _run_claude "$chat_prompt" "chat"
    exit $?
fi

# Multi-task pump loop
if [ "$WORKER_SINGLE_TASK" = "false" ]; then
    while true; do
        _pump_iteration
        case "$PUMP_STATUS" in
            continue) ;;
            stop)     exit 0 ;;
            circuit_break) exit 1 ;;
            *) echo "ERROR: Unknown PUMP_STATUS='${PUMP_STATUS}'" >&2; exit 1 ;;
        esac
    done
else
    # Single task mode
    echo "Polling for tasks..."
    if ! _poll_and_claim_task; then
        exit 1
    fi
    task_prompt="$(_build_task_prompt)"
    _run_claude "$task_prompt" "task"
    exit $?
fi
