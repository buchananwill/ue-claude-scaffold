#!/bin/bash
# container/lib/run-claude.sh — Unified Claude invocation.
# Sourced by entrypoint.sh; do not execute directly.
#
# Usage: _run_claude <prompt> <mode>
#   mode: task | chat | direct

_build_task_prompt_prefix() {
    # Build the runtime-context prefix shared by all modes.
    local prefix=""
    prefix="${prefix}LOG_VERBOSITY: ${LOG_VERBOSITY}
"
    if [ -n "${CHAT_ROOM:-}" ]; then
        prefix="${prefix}CHAT_ROOM: ${CHAT_ROOM}
"
    fi
    if [ -n "${TEAM_ROLE:-}" ]; then
        prefix="${prefix}TEAM_ROLE: ${TEAM_ROLE}
"
    fi
    prefix="${prefix}
---

"
    echo -n "$prefix"
}

_build_task_prompt() {
    # Assemble the full task prompt from claimed task variables.
    local prefix
    prefix="$(_build_task_prompt_prefix)"

    if [ -n "$CURRENT_TASK_SOURCE" ]; then
        # Plan mode: the sourcePath file IS the task specification.
        echo -n "${prefix}TASK_ID: ${CURRENT_TASK_ID}
TASK_TITLE: ${CURRENT_TASK_TITLE}

Read the plan at \`${CURRENT_TASK_SOURCE}\` and carry out the work in accordance with your standard protocol.

The plan file is the complete specification — it contains all phases, file lists, and requirements. File ownership for this task: ${CURRENT_TASK_FILES:-none specified}."
    else
        # Inline mode: description + acceptance criteria from the task record.
        echo -n "${prefix}TASK_ID: ${CURRENT_TASK_ID}
TASK_TITLE: ${CURRENT_TASK_TITLE}

## Task Description

${CURRENT_TASK_DESC}

## Acceptance Criteria

${CURRENT_TASK_AC}

File ownership for this task: ${CURRENT_TASK_FILES:-none specified}."
    fi
}

_build_chat_prompt() {
    # Assemble the chat-agent prompt.
    local prefix
    prefix="$(_build_task_prompt_prefix)"

    echo -n "${prefix}You are in chat room: ${CHAT_ROOM}
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
}

_run_claude() {
    # Unified Claude invocation.
    # Args: <prompt> <mode>
    #   mode: task | chat | direct
    local full_prompt="$1"
    local mode="$2"

    echo "Prompt assembled ($(echo -n "$full_prompt" | wc -c) bytes)"

    # ── Audit: dump full prompt text to log ─────────────────────────────────
    echo ""
    echo "╔══════════════════════════════════════════════════════════════════╗"
    echo "║                    FULL PROMPT TEXT                             ║"
    echo "╚══════════════════════════════════════════════════════════════════╝"
    echo "$full_prompt"
    echo "╔══════════════════════════════════════════════════════════════════╗"
    echo "║                  END FULL PROMPT TEXT                           ║"
    echo "╚══════════════════════════════════════════════════════════════════╝"
    echo ""

    echo "Starting Claude Code (agent: ${AGENT_TYPE:-default}, mode: ${mode})..."
    echo ""

    _post_status "working"

    # Build the claude command arguments
    local CLAUDE_ARGS=(
        -p "$full_prompt"
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
    local CLAUDE_START_TS CLAUDE_END_TS CLAUDE_ELAPSED CLAUDE_PID WATCHDOG_PID EXIT_CODE
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
        ABNORMAL_SHUTDOWN="stop_requested"
        exit 0
    fi

    # ── Abnormal exit detection ─────────────────────────────────────────────
    if _detect_abnormal_exit "$CLAUDE_OUTPUT_LOG"; then
        echo "*** ABNORMAL EXIT DETECTED: ${ABNORMAL_REASON} ***"
        ABNORMAL_SHUTDOWN="true"

        # Discard uncommitted work (presumed invalid)
        cd /workspace
        git checkout -- . 2>/dev/null || true
        git clean -fd 2>/dev/null || true
        git push origin "HEAD:${WORK_BRANCH}" --force 2>/dev/null || true
        echo "Uncommitted work discarded. Branch preserved at last intentional commit."

        # Record the failure
        _post_abnormal_shutdown_message "$ABNORMAL_REASON" "${CURRENT_TASK_ID:-}"

        # Release the task back to pending (not complete, not failed)
        if [ -n "${CURRENT_TASK_ID:-}" ]; then
            echo "Releasing task #${CURRENT_TASK_ID} back to pending..."
            _curl_server -s -X POST "${SERVER_URL}/tasks/${CURRENT_TASK_ID}/release" \
                --max-time 10 >/dev/null 2>&1 || true
            CURRENT_TASK_ID=""  # Prevent _shutdown from double-releasing
        fi
        _post_status "error"

        return 1
    fi

    # ── Normal exit path ────────────────────────────────────────────────────
    if [ "$mode" = "task" ]; then
        _finalize_workspace
    fi

    # Report task completion (task mode only)
    if [ "$mode" = "task" ] && [ -n "${CURRENT_TASK_ID:-}" ]; then
        if [ $EXIT_CODE -eq 0 ]; then
            local complete_payload
            complete_payload=$(jq -n --arg agent "$AGENT_NAME" --argjson exitCode 0 \
                '{"result": {"agent": $agent, "exitCode": $exitCode}}')
            _curl_server -s -X POST "${SERVER_URL}/tasks/${CURRENT_TASK_ID}/complete" \
                -H "Content-Type: application/json" \
                -d "$complete_payload" \
                --max-time 10 >/dev/null 2>&1 || true
        else
            local fail_payload
            fail_payload=$(jq -n --arg error "Claude exited with code ${EXIT_CODE}" \
                '{"error": $error}')
            _curl_server -s -X POST "${SERVER_URL}/tasks/${CURRENT_TASK_ID}/fail" \
                -H "Content-Type: application/json" \
                -d "$fail_payload" \
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
