#!/bin/bash
# container/lib/registration.sh — Server communication, registration, shutdown, stop-watch.
# Sourced by entrypoint.sh; do not execute directly.

_curl_server() {
    curl "$@" -H "X-Agent-Name: ${AGENT_NAME}" -H "X-Project-Id: ${PROJECT_ID}"
}

_post_status() {
    local payload
    payload=$(jq -n --arg s "$1" '{"status": $s}')
    _curl_server -s -X POST "${SERVER_URL}/agents/${AGENT_NAME}/status" \
        -H "Content-Type: application/json" \
        -d "$payload" \
        --max-time 5 >/dev/null 2>&1 || true
}

_detect_abnormal_exit() {
    # Delegates exit classification to the coordination server.
    # Returns 0 (true) if abnormal, 1 (false) if clean.
    # Sets ABNORMAL_REASON to a human-readable description.
    local log_file="$1"
    [ -f "$log_file" ] || return 1

    local log_tail elapsed output_lines response
    log_tail="$(tail -200 "$log_file" | head -c 50000)"
    output_lines="$(wc -l < "$log_file")"

    if [ -n "${CLAUDE_START_TS:-}" ]; then
        local now
        now=$(date +%s)
        elapsed=$((now - CLAUDE_START_TS))
        (( elapsed < 0 )) && elapsed=0
    else
        elapsed=9999
    fi

    # Build JSON payload in a tmpfile to avoid shell escaping issues.
    # NOTE: do NOT use `trap ... RETURN` here — RETURN traps fire on every
    # subsequent function return in the shell (they are not scoped to the
    # defining function), and with `set -u` that turns a stale local-variable
    # reference into a fatal unbound-variable error inside unrelated callers.
    local classify_tmpfile
    classify_tmpfile="$(mktemp)"

    jq -n --arg logTail "$log_tail" --argjson e "$elapsed" --argjson l "$output_lines" \
        '{logTail: $logTail, elapsedSeconds: $e, outputLineCount: $l}' > "$classify_tmpfile" 2>/dev/null

    # If JSON encoding failed, fall back to not-abnormal
    if [ ! -s "$classify_tmpfile" ]; then
        rm -f "$classify_tmpfile"
        return 1
    fi

    response="$(_curl_server -s -X POST "${SERVER_URL}/agents/${AGENT_NAME}/exit-classify" \
        -H "Content-Type: application/json" \
        -d @"$classify_tmpfile" \
        --max-time 10 2>/dev/null)" || { rm -f "$classify_tmpfile"; return 1; }
    rm -f "$classify_tmpfile"

    local is_abnormal
    is_abnormal="$(jq -r '.abnormal // false' <<< "$response")" || return 1

    if [ "$is_abnormal" = "true" ]; then
        ABNORMAL_REASON="$(jq -r '.reason // "unknown"' <<< "$response")" || ABNORMAL_REASON="unknown"
        return 0
    fi

    return 1
}

_post_abnormal_shutdown_message() {
    local reason="$1"
    local task_id="${2:-}"
    # NOTE: avoid `trap ... RETURN` — see _detect_abnormal_exit for why.
    local shutdown_tmpfile
    shutdown_tmpfile=$(mktemp)
    local msg="Agent ${AGENT_NAME} shut down abnormally: ${reason}. Claimed task released. Uncommitted work discarded. Manual restart required."
    jq -n \
        --arg channel "${AGENT_NAME}" \
        --arg agent "${AGENT_NAME}" \
        --arg reason "$reason" \
        --arg taskId "$task_id" \
        --arg message "$msg" \
        '{
            channel: $channel,
            type: "abnormal_shutdown",
            payload: {
                agent: $agent,
                reason: $reason,
                taskId: $taskId,
                message: $message
            }
        }' > "$shutdown_tmpfile" 2>/dev/null
    _curl_server -s -X POST "${SERVER_URL}/messages" \
        -H "Content-Type: application/json" \
        -d @"$shutdown_tmpfile" \
        --max-time 10 >/dev/null 2>&1 || true
    rm -f "$shutdown_tmpfile"
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
    # Deregister the agent (append session token if valid)
    local delete_url="${SERVER_URL}/agents/${AGENT_NAME}"
    if [[ "${SESSION_TOKEN:-}" =~ ^[0-9a-f]{32}$ ]]; then
        delete_url="${delete_url}?sessionToken=${SESSION_TOKEN}"
    fi
    local delete_response
    delete_response=$(_curl_server -s -w "%{http_code}" -X DELETE "$delete_url" \
        --max-time 5 2>/dev/null) || delete_response="000"
    local delete_status="${delete_response: -3}"
    if [[ "$delete_status" == "409" ]]; then
        echo "WARN: DELETE returned 409 — another container has taken over this agent slot"
    fi
}

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

_register_agent() {
    local CONTAINER_IP REG_RESPONSE REG_STATUS REG_BODY reg_payload
    CONTAINER_IP=$(hostname -i 2>/dev/null | awk '{print $1}') || CONTAINER_IP=""
    reg_payload=$(jq -n \
        --arg name "$AGENT_NAME" \
        --arg worktree "$WORK_BRANCH" \
        --arg mode "$AGENT_MODE" \
        --arg containerHost "$CONTAINER_IP" \
        '{"name": $name, "worktree": $worktree, "mode": $mode, "containerHost": $containerHost}')
    REG_RESPONSE=$(_curl_server -s -w "\n%{http_code}" -X POST "${SERVER_URL}/agents/register" \
        -H "Content-Type: application/json" \
        -d "$reg_payload" \
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
}

_smoke_test_messages() {
    local SMOKE_RESPONSE SMOKE_STATUS smoke_payload
    smoke_payload=$(jq -n '{channel: "general", type: "status_update", payload: {message: "Container online. Preparing to launch Claude agent."}}')
    SMOKE_RESPONSE=$(_curl_server -s -w "\n%{http_code}" -X POST "${SERVER_URL}/messages" \
        -H "Content-Type: application/json" \
        -d "$smoke_payload" \
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
}
