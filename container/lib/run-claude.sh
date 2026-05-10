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

# Build the engineer-session prompt by fetching fresh FSM state from the
# coordination server and selecting one of three branches per the durable-
# task FSM contract:
#
#   * cycle 0                              → standard implement-from-plan.
#   * cycle > 0, no arbitration addendum   → revise per consolidated review.
#   * cycle > 0, arbitration addendum set  → revise per addendum (authoritative
#                                            over the consolidated review where
#                                            they conflict).
#
# Fields read from GET /tasks/:id: title, sourcePath, reviewCycleCount,
# latestReviewPath, arbitrationAddendumPath. The prompt names exact transition
# endpoints and failureReason enum values literally so the engineer cannot
# invent free-text values that trip the CHECK constraint. It does NOT inline
# reviewer findings or anti-pattern language — the engineer reads
# latestReviewPath / arbitrationAddendumPath on demand.
_build_engineer_prompt() {
    local task_id="$1"
    local prefix
    prefix="$(_build_task_prompt_prefix)"

    # Defence-in-depth: tasks.id is a serial (integer) on the server. The
    # claim-path regex in pump-loop.sh is looser (`^[0-9a-zA-Z_-]+$`), so a
    # value like `123-foo` could in principle land here. Refuse to embed a
    # non-numeric value into the outbound `${SERVER_URL}/tasks/${task_id}`
    # URL — fall through to the env-fallback (cycle-0 inline-task) branch
    # instead of aborting the daisy-chain. The prompt's literal references
    # to `${task_id}` further down are model-facing text, not curl targets.
    local task_json=""
    if [[ "$task_id" =~ ^[0-9]+$ ]]; then
        # Fetch fresh task state. Empty / unreachable degrades to a minimal
        # cycle-0 prompt seeded from CURRENT_TASK_* variables — better to run
        # with a stale but plausible prompt than to wedge the daisy-chain.
        task_json=$(_curl_server -sf "${SERVER_URL}/tasks/${task_id}" --max-time 10 2>/dev/null) || task_json=""
    else
        echo "WARNING: _build_engineer_prompt received non-numeric task_id '${task_id}'; skipping server fetch and falling back to claim-time variables." >&2
    fi

    local title source_path cycle_count latest_review_path addendum_path
    if [ -n "$task_json" ]; then
        title=$(echo "$task_json"               | jq -r '.title                    // ""' | tr -d '\n')
        source_path=$(echo "$task_json"         | jq -r '.sourcePath               // ""' | tr -d '\n')
        cycle_count=$(echo "$task_json"         | jq -r '.reviewCycleCount         // 0')
        latest_review_path=$(echo "$task_json"  | jq -r '.latestReviewPath         // ""' | tr -d '\n')
        addendum_path=$(echo "$task_json"       | jq -r '.arbitrationAddendumPath  // ""' | tr -d '\n')

        # Conservative path allowlist — block prompt-manipulation via crafted
        # path fields. Title is free-form; newline scrubbing alone is enough.
        # On allowlist failure, treat the path as empty so the cycle-0 branch
        # is taken instead of injecting a malformed path into the prompt.
        # Allowlist regex: hyphen first (literal in bracket class), then
        # alnum/underscore/dot/slash/space. No backslash, so embedded
        # backslashes are also rejected.
        local _path_allow='^[-A-Za-z0-9_./ ]+$'
        if [ -n "$source_path" ] && ! [[ "$source_path" =~ $_path_allow ]]; then
            echo "WARNING: _build_engineer_prompt rejecting non-allowlisted source_path; treating as empty." >&2
            source_path=""
        fi
        if [ -n "$latest_review_path" ] && ! [[ "$latest_review_path" =~ $_path_allow ]]; then
            echo "WARNING: _build_engineer_prompt rejecting non-allowlisted latest_review_path; treating as empty." >&2
            latest_review_path=""
        fi
        if [ -n "$addendum_path" ] && ! [[ "$addendum_path" =~ $_path_allow ]]; then
            echo "WARNING: _build_engineer_prompt rejecting non-allowlisted addendum_path; treating as empty." >&2
            addendum_path=""
        fi
    else
        echo "WARNING: _build_engineer_prompt could not fetch task ${task_id}; falling back to claim-time variables." >&2
        # Apply the same newline scrub on the env-fallback path for
        # consistency, even though these values originated from the same
        # upstream server response at claim time.
        title="$(printf '%s' "${CURRENT_TASK_TITLE:-}" | tr -d '\n')"
        source_path="$(printf '%s' "${CURRENT_TASK_SOURCE:-}" | tr -d '\n')"
        cycle_count=0
        latest_review_path=""
        addendum_path=""
    fi

    # Sanitise non-numeric cycle_count to 0.
    if ! [[ "$cycle_count" =~ ^[0-9]+$ ]]; then
        cycle_count=0
    fi

    # Common header — TASK_ID/TITLE plus the transition contract the engineer
    # session must honour. Same in all three branches.
    local header transitions contradiction_escape
    header="${prefix}TASK_ID: ${task_id}
TASK_TITLE: ${title}
PLAN_PATH: ${source_path:-<inline task — no plan file>}
REVIEW_CYCLE_COUNT: ${cycle_count}

File ownership for this task: ${CURRENT_TASK_FILES:-none specified}."

    transitions="## Transition contract

You are responsible for posting your own FSM transitions. The wrapper does not
post /complete or /fail on your behalf.

On a clean build + commit + debrief:
  POST \${SERVER_URL}/tasks/${task_id}/transition
    Content-Type: application/json
    Body: {\"to\": \"built\", \"payload\": {\"buildStatus\": \"clean\", \"commitSha\": \"<sha>\"}}

On an unrecoverable build failure (after retries):
  POST \${SERVER_URL}/tasks/${task_id}/transition
    Content-Type: application/json
    Body: {\"to\": \"failed\", \"payload\": {\"failureReason\": \"engineer_build_failure\", \"failureDetail\": \"<concise build error summary>\"}}

The failureReason value MUST be the literal string \`engineer_build_failure\`.
Do not invent free-text values — the server enforces this with a CHECK
constraint and will reject anything else with HTTP 400.

Use \${SERVER_URL} (already exported in your shell) and include the standard
\`X-Agent-Name\` and \`X-Project-Id\` headers (the inject-agent-header hook
adds these automatically on outbound curl)."

    contradiction_escape="## Contradiction escape hatch

If two reviewer findings cannot both be satisfied (one says 'split this',
another says 'lock this together'), do not pick one. Quote both findings
verbatim and POST:

  POST \${SERVER_URL}/tasks/${task_id}/transition
    Content-Type: application/json
    Body: {\"to\": \"arbitrating\", \"payload\": {\"trigger\": \"reviewer_contradiction\", \"contradiction\": {\"findingIds\": [\"<id-a>\", \"<id-b>\"], \"notes\": \"<why these conflict>\"}}}

An arbitrator session will rule between the findings or escalate to the
operator. The trigger value MUST be the literal string \`reviewer_contradiction\`."

    if [ "$cycle_count" = "0" ]; then
        # Branch 1: cycle 0 — standard implement-from-plan.
        if [ -n "$source_path" ]; then
            echo -n "${header}

## Implement-from-plan (cycle 0)

Read the plan at \`${source_path}\` and carry out the work for this phase in
accordance with your standard protocol. The plan file is the complete
specification — it contains all phases, file lists, and requirements. The
phase identifier is encoded in TASK_TITLE above.

${transitions}

${contradiction_escape}"
        else
            echo -n "${header}

## Implement-from-task (cycle 0)

This task has no plan file (sourcePath is empty). Carry out the work using
the title, description, and acceptance criteria of TASK_ID ${task_id} as the
specification. Re-read the task body via \`GET \${SERVER_URL}/tasks/${task_id}\`
if you need the full description text.

${transitions}

${contradiction_escape}"
        fi
    elif [ -z "$addendum_path" ]; then
        # Branch 2: revision cycle without an arbitration addendum.
        # Note: avoid `${var:-<...${SERVER_URL}>}` here — bash parses the
        # default-substitution arm greedily and an unescaped inner `}` would
        # close the outer expansion early, splicing trailing literal text.
        local lrp_display="$latest_review_path"
        [ -z "$lrp_display" ] && lrp_display="<latestReviewPath missing — refetch GET /tasks/${task_id}>"
        echo -n "${header}

## Revision cycle ${cycle_count} (no arbitration)

This task is in a revision cycle. Read the consolidated review at:

  ${lrp_display}

Address every BLOCKING entry. NOTE entries are observability only — do not
act on them. Re-build clean. Post the \`built\` transition with the new
commitSha.

Do not paraphrase the consolidated review into your working memory — read
it directly when you need it, scoped to one fix pass.

${transitions}

${contradiction_escape}"
    else
        # Branch 3: revision cycle with an arbitration addendum.
        local lrp_display="$latest_review_path"
        [ -z "$lrp_display" ] && lrp_display="<latestReviewPath missing>"
        echo -n "${header}

## Revision cycle ${cycle_count} (post-arbitration)

This task is in a revision cycle following an arbitrator ruling. Read both:

  Consolidated review: ${lrp_display}
  Arbitrator addendum: ${addendum_path}

The addendum is AUTHORITATIVE where it conflicts with the consolidated
review — it names which BLOCKING finding was upheld and which was retired.
Address only the upheld findings; ignore the retired ones. NOTE entries are
observability only. Re-build clean. Post the \`built\` transition with the
new commitSha.

Do not paraphrase either file into your working memory — read both directly
when you need them, scoped to one fix pass.

${transitions}

${contradiction_escape}"
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

_finalize_session() {
    # Close an open session record with status, exit code, parsed token usage,
    # and the raw `result` event captured from Claude's stream-json output.
    # No-op if no session was opened (CURRENT_SESSION_ID empty). All failures
    # are silent and non-fatal — the agent's primary work must never break
    # because the sessions endpoint is unreachable.
    local status="$1" exit_code="$2"
    [ -z "$CURRENT_SESSION_ID" ] && return

    # Extract result event (last line matching '"type":"result"')
    local result_event=""
    if [ -f "$CLAUDE_OUTPUT_LOG" ]; then
        result_event=$(grep '"type":"result"' "$CLAUDE_OUTPUT_LOG" 2>/dev/null | tail -1 || true)
    fi

    # Parse token fields; fall back to null on any failure
    local input_t output_t cache_read_t cache_create_t
    input_t=$(echo "$result_event"       | jq -r '.usage.input_tokens                // empty' 2>/dev/null) || true
    output_t=$(echo "$result_event"      | jq -r '.usage.output_tokens               // empty' 2>/dev/null) || true
    cache_read_t=$(echo "$result_event"  | jq -r '.usage.cache_read_input_tokens     // empty' 2>/dev/null) || true
    cache_create_t=$(echo "$result_event" | jq -r '.usage.cache_creation_input_tokens // empty' 2>/dev/null) || true

    # Build PATCH payload in tmpfile
    local patch_tmp
    patch_tmp=$(mktemp)
    if ! jq -n \
            --arg     status              "$status" \
            --argjson exitCode            "${exit_code}" \
            --argjson inputTokens         "${input_t:-null}" \
            --argjson outputTokens        "${output_t:-null}" \
            --argjson cacheReadTokens     "${cache_read_t:-null}" \
            --argjson cacheCreationTokens "${cache_create_t:-null}" \
            --argjson rawOutput           "${result_event:-null}" \
            '{status:$status,exitCode:$exitCode,
              inputTokens:$inputTokens,outputTokens:$outputTokens,
              cacheReadTokens:$cacheReadTokens,cacheCreationTokens:$cacheCreationTokens,
              rawOutput:$rawOutput}' > "$patch_tmp" 2>/dev/null; then
        # Graceful fallback: minimal patch without token fields
        jq -n --arg status "$status" --argjson exitCode "${exit_code}" \
            '{status:$status,exitCode:$exitCode}' > "$patch_tmp" 2>/dev/null || true
    fi

    _curl_server -s -X PATCH "${SERVER_URL}/sessions/${CURRENT_SESSION_ID}" \
        -H "Content-Type: application/json" \
        -d @"$patch_tmp" \
        --max-time 10 >/dev/null 2>&1 || true
    rm -f "$patch_tmp"
    CURRENT_SESSION_ID=""
}

_run_claude() {
    # Unified Claude invocation.
    # Args: <prompt> <mode>
    #   mode: task | chat | direct
    local full_prompt="$1"
    local mode="$2"

    # Daisy-chain role selection (Phase 4): when invoked from _run_role_session,
    # DAISY_CHAIN_ROLE and DAISY_CHAIN_ROLES_FILE are set. We look up the
    # agent-definition basename for the requested role from the resolved roles
    # JSON. Falls back to the container default if the role is unmapped — the
    # daisy-chain itself enforces that unmapped reviewer/arbitrator slots are
    # stubbed out, so this fallback only fires for engineer in early phases.
    local effective_agent_type=""
    if [ -n "${DAISY_CHAIN_ROLE:-}" ] && [ -n "${DAISY_CHAIN_ROLES_FILE:-}" ] && [ -f "$DAISY_CHAIN_ROLES_FILE" ]; then
        local role_agent
        role_agent=$(jq -r --arg r "$DAISY_CHAIN_ROLE" '.[$r] // empty' "$DAISY_CHAIN_ROLES_FILE" 2>/dev/null) || role_agent=""
        if [ -n "$role_agent" ] && _is_safe_name "$role_agent"; then
            effective_agent_type="$role_agent"
            echo "Daisy-chain: role '${DAISY_CHAIN_ROLE}' → agent '${effective_agent_type}'"
        fi
    fi

    # Per-task agent type override beats default; daisy-chain role wins above both
    if [ -z "$effective_agent_type" ]; then
        effective_agent_type="${CURRENT_TASK_AGENT_TYPE:-$AGENT_TYPE}"
    fi

    # Defence-in-depth: validate effective_agent_type against allowlist
    if [ -n "$effective_agent_type" ] && ! _is_safe_name "$effective_agent_type"; then
        echo "ERROR: effective_agent_type contains invalid characters: $effective_agent_type" >&2
        return 1
    fi

    # Engineer-session prompt substitution (Phase 5). When the daisy-chain
    # invokes us with DAISY_CHAIN_ROLE=engineer, the generic _build_task_prompt
    # produced by the pump-loop is replaced with an engineer-specific prompt
    # that selects one of three branches (cycle 0 / revision / post-arbitration)
    # based on FSM state read from GET /tasks/:id. The engineer reads
    # latestReviewPath / arbitrationAddendumPath on demand rather than having
    # them inlined into the system prompt — this preserves the "engineers must
    # not be primed with anti-pattern language" property called out in the
    # plan.
    if [ "${DAISY_CHAIN_ROLE:-}" = "engineer" ] && [ -n "${CURRENT_TASK_ID:-}" ]; then
        echo "Daisy-chain: building engineer-session prompt for task ${CURRENT_TASK_ID} (cycle ${DAISY_CHAIN_CYCLE:-?})"
        full_prompt="$(_build_engineer_prompt "$CURRENT_TASK_ID")"
    fi

    # Clear any stale stop sentinel from a prior container run
    rm -f /tmp/.stop_requested

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

    echo "Starting Claude Code (agent: ${effective_agent_type:-default}, mode: ${mode})..."
    echo ""

    _post_status "working"

    # Build the claude command arguments
    local CLAUDE_ARGS=(
        -p "$full_prompt"
        --dangerously-skip-permissions
        --output-format stream-json
        --verbose
        --max-turns "$MAX_TURNS"
        --effort "${CLAUDE_EFFORT:-high}"
        --mcp-config /home/claude/.claude/mcp.json
        --debug-file /logs/claude-debug.log
    )
    if [ -n "${CHAT_ROOM:-}" ]; then
        CLAUDE_ARGS+=(--channels server:chat --dangerously-load-development-channels server:chat)
    fi
    if [ -n "$effective_agent_type" ]; then
        CLAUDE_ARGS+=(--agent "$effective_agent_type")
    fi

    # Capture output for abnormal exit detection
    rm -f "$CLAUDE_OUTPUT_LOG"
    local CLAUDE_START_TS CLAUDE_END_TS CLAUDE_ELAPSED CLAUDE_PID WATCHDOG_PID EXIT_CODE
    CLAUDE_START_TS=$(date +%s)

    # ── Open session record ─────────────────────────────────────────────────
    # POST /sessions with our agent UUID and (optional) current task ID.
    # On success, capture the returned session UUID; on any failure, leave
    # CURRENT_SESSION_ID empty so _finalize_session is a no-op.
    CURRENT_SESSION_ID=""
    local task_id_json="null"
    [ -n "${CURRENT_TASK_ID:-}" ] && task_id_json="$CURRENT_TASK_ID"
    local sess_open_tmp
    sess_open_tmp=$(mktemp)
    jq -n \
        --arg     agentId "$AGENT_ID" \
        --argjson taskId  "$task_id_json" \
        '{"agentId":$agentId,"taskId":$taskId}' > "$sess_open_tmp" 2>/dev/null || true
    local sess_resp
    sess_resp=$(_curl_server -s -X POST "${SERVER_URL}/sessions" \
        -H "Content-Type: application/json" \
        -d @"$sess_open_tmp" \
        --max-time 5 2>/dev/null) || sess_resp=""
    rm -f "$sess_open_tmp"
    CURRENT_SESSION_ID=$(echo "$sess_resp" | jq -r '.id // empty' 2>/dev/null) || CURRENT_SESSION_ID=""
    # Defence-in-depth: validate UUID shape before embedding in PATCH URL.
    # Malformed/missing values short-circuit _finalize_session to its no-op branch.
    if [[ ! "${CURRENT_SESSION_ID:-}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
        CURRENT_SESSION_ID=""
    fi

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
        _finalize_session "stopped" "$EXIT_CODE"
        exit 0
    fi

    # ── Abnormal exit detection ─────────────────────────────────────────────
    if _detect_abnormal_exit "$CLAUDE_OUTPUT_LOG" "$EXIT_CODE"; then
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

        _finalize_session "aborted" "$EXIT_CODE"
        return 1
    fi

    # ── Normal exit path ────────────────────────────────────────────────────
    if [ "$mode" = "task" ]; then
        _finalize_workspace
    fi

    # Phase 4: the wrapper no longer auto-posts /tasks/:id/complete or /fail
    # based on Claude's exit code. Under the durable-task FSM, transitions are
    # owned exclusively by the role session itself (which posts /transition
    # with the appropriate target). The daisy-chain in pump-loop.sh detects
    # the role_session_no_op case (clean exit + unchanged status) and posts
    # /transition with failureReason='role_session_no_op' from there.
    # The /release post on the abnormal-exit branch above is unchanged.

    if [ "$EXIT_CODE" -eq 0 ]; then
        _post_status "done"
    else
        _post_status "error"
    fi

    _finalize_session "complete" "$EXIT_CODE"
    return $EXIT_CODE
}
