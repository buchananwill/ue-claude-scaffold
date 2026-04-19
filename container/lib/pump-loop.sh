#!/bin/bash
# container/lib/pump-loop.sh — Task polling, claiming, and pump iteration.
# Sourced by entrypoint.sh; do not execute directly.

_poll_and_claim_task() {
    local max_attempts=60
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        attempt=$((attempt + 1))

        # Stop detection
        local agent_st
        agent_st=$(_curl_server -sf "${SERVER_URL}/agents/${AGENT_NAME}" --max-time 5 2>/dev/null | jq -r '.status // "unknown"') || agent_st="unknown"
        if [ "$agent_st" = "stopping" ]; then
            echo "Stop signal received during task poll — shutting down."
            ABNORMAL_SHUTDOWN="stop_requested"
            exit 0
        fi

        # Use claim-next endpoint
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
            if [[ ! "$CURRENT_TASK_ID" =~ ^[0-9a-zA-Z_-]+$ ]]; then
                echo "ERROR: Received malformed task ID from server: $CURRENT_TASK_ID" >&2
                PUMP_STATUS="circuit_break"
                return 1
            fi
            CURRENT_TASK_TITLE=$(echo "$body" | jq -r '.task.title // "Untitled"')
            CURRENT_TASK_DESC=$(echo "$body" | jq -r '.task.description // ""')
            CURRENT_TASK_AC=$(echo "$body" | jq -r '.task.acceptanceCriteria // "None specified"')
            CURRENT_TASK_SOURCE=$(echo "$body" | jq -r '.task.sourcePath // ""')
            CURRENT_TASK_FILES=$(echo "$body" | jq -r '(.task.files // []) | join(", ")')
            CURRENT_TASK_AGENT_TYPE=$(echo "$body" | jq -r '.task.agentTypeOverride // ""')
            # Allowlist: reject agent type overrides with unsafe characters
            if [ -n "$CURRENT_TASK_AGENT_TYPE" ] && [[ ! "$CURRENT_TASK_AGENT_TYPE" =~ ^[a-zA-Z0-9_-]+$ ]]; then
                echo "ERROR: agentTypeOverride contains invalid characters: $CURRENT_TASK_AGENT_TYPE" >&2
                CURRENT_TASK_AGENT_TYPE=""
            fi
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

        blocked=$(echo "$body" | jq -r '.blocked // 0')
        _post_status "idle"
        echo "No claimable tasks (${pending} pending, ${blocked} blocked by file ownership). Waiting ${WORKER_POLL_INTERVAL}s... (${attempt}/${max_attempts})"
        sleep "$WORKER_POLL_INTERVAL"
    done

    echo "ERROR: No claimable tasks found after ${max_attempts} attempts"
    _post_status "error"
    return 1
}

# _pump_iteration runs one task cycle and returns a status enum.
# Returns via PUMP_STATUS variable: continue | stop | circuit_break
_pump_iteration() {
    local TASK_EXIT
    PUMP_STATUS="continue"
    ABNORMAL_SHUTDOWN=""  # Reset per-task
    ABNORMAL_REASON=""    # Keep in sync with ABNORMAL_SHUTDOWN

    echo "Polling for tasks..."
    if ! _poll_and_claim_task; then
        if [ "$PUMP_STATUS" != "circuit_break" ]; then
            PUMP_STATUS="stop"
        fi
        return
    fi

    # If the task has an agent type override, fetch and cache the definition
    if [ -n "${CURRENT_TASK_AGENT_TYPE:-}" ]; then
        echo "Task has agent type override: ${CURRENT_TASK_AGENT_TYPE}"
        if ! _ensure_agent_type "$CURRENT_TASK_AGENT_TYPE"; then
            echo "ERROR: Could not fetch agent definition '${CURRENT_TASK_AGENT_TYPE}'. Releasing task." >&2
            _curl_server -s -X POST "${SERVER_URL}/tasks/${CURRENT_TASK_ID}/release" \
                --max-time 10 >/dev/null 2>&1 || true
            CURRENT_TASK_ID=""
            CURRENT_TASK_TITLE=""
            CURRENT_TASK_DESC=""
            CURRENT_TASK_AC=""
            CURRENT_TASK_SOURCE=""
            CURRENT_TASK_FILES=""
            CURRENT_TASK_AGENT_TYPE=""
            return
        fi
    fi

    local task_prompt
    task_prompt="$(_build_task_prompt)"

    set +e
    _run_claude "$task_prompt" "task"
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
            PUMP_STATUS="circuit_break"
            return
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
    CURRENT_TASK_AGENT_TYPE=""

    # Check if agent has been stopped or paused
    local agent_status
    agent_status=$(_curl_server -sf "${SERVER_URL}/agents/${AGENT_NAME}" \
        --max-time 5 2>/dev/null | jq -r '.status // "unknown"') || agent_status="unknown"
    if [ "$agent_status" = "stopping" ]; then
        echo "Agent deregistered — shutting down."
        PUMP_STATUS="stop"
        return
    fi

    if [ "$agent_status" = "paused" ]; then
        echo "Agent is paused. Waiting for resume..."
        while true; do
            sleep "$WORKER_POLL_INTERVAL"
            agent_status=$(_curl_server -sf "${SERVER_URL}/agents/${AGENT_NAME}" \
                --max-time 5 2>/dev/null | jq -r '.status // "unknown"') || agent_status="unknown"
            if [ "$agent_status" = "stopping" ]; then
                echo "Agent deregistered — shutting down."
                PUMP_STATUS="stop"
                return
            fi
            if [ "$agent_status" != "paused" ]; then
                echo "Agent resumed (status: ${agent_status})."
                break
            fi
        done
    fi

    echo ""
    echo "=== Task complete (exit $TASK_EXIT). Polling for next task... ==="
    echo ""
}
