#!/bin/bash
# container/lib/pump-loop.sh — Task polling, claiming, and pump iteration.
# Sourced by entrypoint.sh; do not execute directly.
#
# Phase 4 of the durable-task FSM rework replaces the per-task body of
# `_pump_iteration` with a state-driven daisy-chain. After a task is claimed,
# we read `task.status`, pick a role from the FSM, run that role as a top-level
# `claude -p` session, re-read the task to pick up any transition the session
# posted, and repeat until the task reaches a terminal state.
#
# The legacy noncomplete-circuit-breaker (and its CONSECUTIVE_NONCOMPLETE
# counter) is gone: under the new design, terminal transitions are exclusively
# authored by living, signed-in role sessions, so a zombie auth-dead container
# can no longer cycle through tasks marking them `failed`. Auth-dead containers
# route to `/release` (not `/fail`) and trip the preserved CONSECUTIVE_ABNORMAL
# breaker after two consecutive abnormal exits.

# Map FSM status to the role that should run next. Echoes the role name on
# stdout for non-terminal states; echoes empty on terminal states. The caller
# decides whether to exit the daisy-chain loop based on emptiness.
#
# FSM-status alignment: the non-terminal cases below mirror the active-state
# set in server/src/queries/query-helpers.ts (ACTIVE_STATUSES), which is the
# TS source of truth for "task is actively held". When the schema CHECK
# (server/src/schema/tables.ts:tasks_status_check) gains or drops a non-
# terminal status, both this case and ACTIVE_STATUSES must be updated in
# lockstep — there is no compile-time link between them.
_role_for_status() {
    case "$1" in
        claimed|revising|engineering)  echo "engineer" ;;
        built|reviewing)               echo "reviewer-fanout" ;;
        arbitrating)                   echo "arbitrator" ;;
        complete|failed|integrated)    echo "" ;;
        *)                             echo "" ;;
    esac
}

# Post a `failed` transition with reason `role_session_no_op` and the given
# detail string. Used by the daisy-chain (when a session exits cleanly without
# transitioning) and by _pump_iteration (when an agent-type fetch fails before
# any session can run). The single seam keeps the failure-reason vocabulary
# consistent and gives Phase 8's failure-reason aggregator one place to wire
# structured logging. Errors are intentionally swallowed: a failed POST here
# leaves the task in its current state, which the next iteration will detect.
_post_role_session_no_op() {
    local task_id="$1"
    local detail="$2"
    local payload
    payload=$(jq -n \
        --arg reason "role_session_no_op" \
        --arg detail "$detail" \
        '{to: "failed", payload: {failureReason: $reason, failureDetail: $detail}}')
    _curl_server -s -X POST "${SERVER_URL}/tasks/${task_id}/transition" \
        -H "Content-Type: application/json" \
        -d "$payload" \
        --max-time 10 >/dev/null 2>&1 || true
}

# Fetch the agent's current status from the coordination server. Echoes the
# parsed status string on stdout, or "unknown" on any error. Both the claim-
# loop stop-detection probe and the post-iteration pause/stop probe go through
# this helper so the curl/jq plumbing lives in one place.
_get_agent_status() {
    _curl_server -sf "${SERVER_URL}/agents/${AGENT_NAME}" \
        --max-time 5 2>/dev/null | jq -r '.status // "unknown"' \
        || echo "unknown"
}

# Block while the agent's status is `paused`, polling every WORKER_POLL_INTERVAL
# seconds. Returns 0 when the agent resumes (status changes to anything other
# than `paused`). Returns 1 if the agent transitions to `stopping` while we
# wait, or if /tmp/.stop_requested appears — the caller must propagate that as
# a shutdown.
#
# The /tmp/.stop_requested check covers SIGTERM-style shutdowns that bypass the
# server-side pause→stop status transition (run-claude.sh writes that sentinel
# in its stop hook). Without it, a direct SIGTERM during pause would be ignored
# for up to one WORKER_POLL_INTERVAL (default 30s) while sleep blocks.
#
# This is the post-iteration variant: it expects to be entered only when the
# caller has already observed status == `paused`. The claim-loop probe in
# _poll_and_claim_task does not block on `paused` (it surfaces the status to
# the per-iteration sleep instead), so it stays inline.
_wait_while_paused() {
    local agent_status="paused"
    while [ "$agent_status" = "paused" ]; do
        if [ -f /tmp/.stop_requested ]; then
            return 1
        fi
        sleep "${WORKER_POLL_INTERVAL:-30}"
        agent_status=$(_get_agent_status)
        if [ "$agent_status" = "stopping" ]; then
            return 1
        fi
    done
    echo "Agent resumed (status: ${agent_status})."
    return 0
}

# Resolve effective agent-roles for the current task by shallow-merging
# project.agentRoles with task.agentRolesOverride. Top-level keys (engineer,
# arbitrator, reviewers) replace wholesale — a `{"reviewers": {...}}` override
# replaces the entire reviewers map; partial-reviewer overrides require
# restating the whole reviewers object.
#
# Side effect: writes the resolved roles JSON to $1 (a tmpfile path).
# The caller is responsible for removing it.
_resolve_roles_for_task() {
    local out_file="$1"
    local task_json="$2"

    local proj_resp
    proj_resp=$(_curl_server -sf "${SERVER_URL}/projects/${PROJECT_ID}" --max-time 10 2>/dev/null) || proj_resp=""
    local proj_roles="{}"
    if [ -n "$proj_resp" ]; then
        proj_roles=$(echo "$proj_resp" | jq -c '.agentRoles // {}' 2>/dev/null) || proj_roles="{}"
    fi

    local task_override
    task_override=$(echo "$task_json" | jq -c '.agentRolesOverride // {}' 2>/dev/null) || task_override="{}"

    # Shallow merge: override keys replace project keys wholesale (jq's `*`
    # operator on objects merges recursively, but a top-level `+` replaces).
    jq -nc \
        --argjson base "$proj_roles" \
        --argjson over "$task_override" \
        '$base + $over' > "$out_file" 2>/dev/null || echo '{}' > "$out_file"
}

# Run a single role session: invoke claude -p and capture output. Returns the
# claude exit code. The session is responsible for posting its own FSM
# transition; this wrapper only invokes the binary and writes a per-cycle log
# under .scratch/reviews/<task-id>/cycle-<N>/.
_run_role_session() {
    local role="$1"
    local task_id="$2"
    local cycle="$3"
    local roles_file="$4"

    local scratch_dir="/workspace/.scratch/reviews/${task_id}/cycle-${cycle}"
    mkdir -p "$scratch_dir"

    local logfile="${scratch_dir}/${role}.log"
    echo "── Daisy-chain: role=${role} task=${task_id} cycle=${cycle} ──"

    # Build the per-role prompt. Phases 5/6/7 will replace this with role-
    # specific prompt construction; for now we reuse the standard task prompt
    # and let `run-claude.sh` pick the agent definition from the resolved roles
    # map via DAISY_CHAIN_ROLE / DAISY_CHAIN_ROLES_FILE.
    local prompt
    prompt="$(_build_task_prompt)"

    DAISY_CHAIN_ROLE="$role" \
    DAISY_CHAIN_ROLES_FILE="$roles_file" \
    DAISY_CHAIN_CYCLE="$cycle" \
    DAISY_CHAIN_LOG="$logfile" \
    _run_claude "$prompt" "task"
    return $?
}

# Drive a single claimed task through the FSM until terminal. Reads task
# status, picks a role, runs the session, re-reads, repeats. If a session
# exits cleanly but the task status is unchanged, post `failed` with
# `role_session_no_op`.
_run_daisy_chain() {
    local task_id="$1"
    local cycle=0
    local last_status=""
    local roles_file
    roles_file=$(mktemp)

    # Resolve effective agent-roles once per task (cached for the loop).
    # Re-read task fresh so the override (if any) is the latest committed.
    local initial_task
    initial_task=$(_curl_server -sf "${SERVER_URL}/tasks/${task_id}" --max-time 10 2>/dev/null) || initial_task=""
    _resolve_roles_for_task "$roles_file" "$initial_task"

    while true; do
        cycle=$((cycle + 1))

        # Re-read the task each iteration to pick up FSM transitions posted
        # by the previous session.
        local task_json status
        task_json=$(_curl_server -sf "${SERVER_URL}/tasks/${task_id}" --max-time 10 2>/dev/null) || task_json=""
        if [ -z "$task_json" ]; then
            echo "ERROR: could not re-read task ${task_id}; aborting daisy-chain." >&2
            rm -f "$roles_file"
            return 1
        fi
        status=$(echo "$task_json" | jq -r '.status // empty')

        local role
        role=$(_role_for_status "$status")
        if [ -z "$role" ]; then
            echo "Task ${task_id} reached terminal status '${status}'; daisy-chain complete."
            rm -f "$roles_file"
            return 0
        fi

        # Phase 6 wires the reviewer fan-out via _run_reviewer_fanout
        # (sourced from container/lib/reviewer-fanout.sh by entrypoint.sh and
        # dispatched from _run_claude on DAISY_CHAIN_ROLE=reviewer-fanout).
        # Phase 7 wires the arbitrator the same way: _run_role_session below
        # invokes _run_claude with DAISY_CHAIN_ROLE=arbitrator, which sources
        # container/lib/arbitrator-dispatch.sh and hands off to
        # _run_arbitrator_dispatch. The arbitrator branch is no longer
        # stubbed here.

        echo "Daisy-chain cycle ${cycle}: status='${status}' → role='${role}'"
        last_status="$status"

        local sess_exit
        set +e
        _run_role_session "$role" "$task_id" "$cycle" "$roles_file"
        sess_exit=$?
        set -e

        # Abnormal exit: the session wrapper has already posted /release and
        # set ABNORMAL_SHUTDOWN. Bail out — the pump loop's outer breaker
        # handles consecutive abnormals.
        if [ -n "$ABNORMAL_SHUTDOWN" ]; then
            echo "Daisy-chain: abnormal exit detected; surrendering task ${task_id}."
            rm -f "$roles_file"
            return 1
        fi

        # Re-read status: if the session exited cleanly but did not transition,
        # post role_session_no_op → failed. This is the only path that can
        # take a task to `failed` from the wrapper now.
        local post_json post_status
        post_json=$(_curl_server -sf "${SERVER_URL}/tasks/${task_id}" --max-time 10 2>/dev/null) || post_json=""
        post_status=$(echo "$post_json" | jq -r '.status // empty')

        if [ "$sess_exit" -eq 0 ] && [ "$post_status" = "$last_status" ]; then
            echo "*** role_session_no_op: role '${role}' returned without transitioning task ${task_id} (cycle ${cycle}). ***"
            _post_role_session_no_op "$task_id" \
                "role session for ${role} returned without posting transition (cycle ${cycle})"
            rm -f "$roles_file"
            return 1
        fi

        # If the role session exited non-zero (other than abnormal, which is
        # handled above), bail. The session itself should have transitioned
        # the task to a meaningful state; if not, the next iteration will
        # detect role_session_no_op or read a terminal status.
        if [ "$sess_exit" -ne 0 ]; then
            echo "Daisy-chain: role '${role}' exited ${sess_exit}; halting loop for task ${task_id}."
            rm -f "$roles_file"
            return "$sess_exit"
        fi
    done
}

# Resume any tasks already mid-cycle for *this* agent UUID. Used at container
# startup so OAuth expiries / host reboots do not strand work. We filter by
# AGENT_ID (UUID, identity), not AGENT_NAME (slot label) — names are reusable
# UI labels and another container could be re-using the slot.
_resume_in_flight_tasks() {
    if [ -z "${AGENT_ID:-}" ]; then
        echo "Startup probe: AGENT_ID not set; skipping resume."
        return 0
    fi

    # Probe set: ACTIVE_STATUSES from server/src/queries/query-helpers.ts minus
    # `claimed`. A freshly-claimed task has not yet had any role session run,
    # so it has no in-progress work to "resume" — the normal claim path in
    # _poll_and_claim_task is responsible for picking it up via daisy-chain on
    # the next iteration. Listing `claimed` here would race with that path and
    # double-process the row. When ACTIVE_STATUSES grows or shrinks in TS, this
    # list must be updated in lockstep (see also _role_for_status above).
    local active_statuses="engineering,built,reviewing,revising,arbitrating"
    local resp
    resp=$(_curl_server -sf "${SERVER_URL}/tasks?status=${active_statuses}&claimedByAgentId=${AGENT_ID}&limit=50" \
        --max-time 10 2>/dev/null) || resp=""
    if [ -z "$resp" ]; then
        echo "Startup probe: no in-flight tasks (or server unreachable)."
        return 0
    fi

    local count
    count=$(echo "$resp" | jq -r '.total // 0' 2>/dev/null) || count=0
    if [ "$count" = "0" ]; then
        echo "Startup probe: no in-flight tasks for agent ${AGENT_ID:0:8}..."
        return 0
    fi

    echo "Startup probe: ${count} in-flight task(s) found for agent ${AGENT_ID:0:8}...; resuming daisy-chain."

    local ids
    ids=$(echo "$resp" | jq -r '.tasks[].id' 2>/dev/null) || ids=""
    local id
    for id in $ids; do
        if [[ ! "$id" =~ ^[0-9]+$ ]]; then
            echo "Startup probe: skipping malformed id '${id}'." >&2
            continue
        fi
        echo "Startup probe: resuming task #${id}"
        # Hydrate CURRENT_TASK_* from the row so _build_task_prompt has a
        # complete record. We don't re-claim — the row is already claimed.
        local row
        row=$(echo "$resp" | jq -c --argjson tid "$id" '.tasks[] | select(.id == $tid)')
        CURRENT_TASK_ID="$id"
        CURRENT_TASK_TITLE=$(echo "$row" | jq -r '.title // "Untitled"')
        CURRENT_TASK_DESC=$(echo "$row" | jq -r '.description // ""')
        CURRENT_TASK_AC=$(echo "$row" | jq -r '.acceptanceCriteria // "None specified"')
        CURRENT_TASK_SOURCE=$(echo "$row" | jq -r '.sourcePath // ""')
        CURRENT_TASK_FILES=$(echo "$row" | jq -r '(.files // []) | join(", ")')
        CURRENT_TASK_AGENT_TYPE=$(echo "$row" | jq -r '.agentTypeOverride // ""')
        if [ -n "$CURRENT_TASK_AGENT_TYPE" ] && ! _is_safe_name "$CURRENT_TASK_AGENT_TYPE"; then
            echo "Startup probe: agentTypeOverride contains invalid characters; clearing." >&2
            CURRENT_TASK_AGENT_TYPE=""
        fi
        if [ -n "${CURRENT_TASK_AGENT_TYPE:-}" ]; then
            _ensure_agent_type "$CURRENT_TASK_AGENT_TYPE" || true
        fi

        ABNORMAL_SHUTDOWN=""
        ABNORMAL_REASON=""
        set +e
        _run_daisy_chain "$id"
        set -e

        # Per-task branch reset between resumes
        cd /workspace
        git fetch origin 2>/dev/null || true
        git reset --hard "origin/${WORK_BRANCH}" 2>/dev/null || git reset --hard HEAD
        git clean -fd
        _reset_task_vars
    done
}

_poll_and_claim_task() {
    local max_attempts=60
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        attempt=$((attempt + 1))

        # Stop detection. Note: this probe only acts on `stopping`, not
        # `paused` — pausing during the claim-poll is naturally absorbed by
        # the per-iteration sleep below, so blocking here would be redundant.
        local agent_st
        agent_st=$(_get_agent_status)
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
            if [ -f /tmp/.stop_requested ]; then
                echo "Stop signal received during claim-poll — shutting down."
                ABNORMAL_SHUTDOWN="stop_requested"
                exit 0
            fi
            sleep "${WORKER_POLL_INTERVAL:-30}"
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
            if [ -n "$CURRENT_TASK_AGENT_TYPE" ] && ! _is_safe_name "$CURRENT_TASK_AGENT_TYPE"; then
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
        if [ -f /tmp/.stop_requested ]; then
            echo "Stop signal received during claim-poll — shutting down."
            ABNORMAL_SHUTDOWN="stop_requested"
            exit 0
        fi
        sleep "${WORKER_POLL_INTERVAL:-30}"
    done

    echo "ERROR: No claimable tasks found after ${max_attempts} attempts"
    _post_status "error"
    return 1
}

# _pump_iteration runs one task cycle and returns a status enum.
# Returns via PUMP_STATUS variable: continue | stop | circuit_break
#
# Phase 4: the per-task body is now a state-driven daisy-chain. Surrounding
# scaffolding — abnormal-exit detection, CONSECUTIVE_ABNORMAL breaker, agent-
# status pause/resume polling, agent-type-override fetch, per-task branch
# reset — is preserved. The legacy CONSECUTIVE_NONCOMPLETE breaker is dropped
# because terminal state is now exclusively authored by living role sessions:
# auth-dead containers route to /release (back to pending), not /fail.
_pump_iteration() {
    local CHAIN_EXIT
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

    # If the task has an agent type override, fetch and cache the definition.
    # Fetch failure transitions the task to 'failed' with role_session_no_op
    # via the daisy-chain's no-op handler (the wrapper can no longer post
    # /fail directly). For now we still emit a status post and skip the loop
    # so the task does not re-claim in a tight loop.
    if [ -n "${CURRENT_TASK_AGENT_TYPE:-}" ]; then
        echo "Task has agent type override: ${CURRENT_TASK_AGENT_TYPE}"
        if ! _ensure_agent_type "$CURRENT_TASK_AGENT_TYPE"; then
            local fail_id="$CURRENT_TASK_ID"
            echo "ERROR: Could not fetch agent definition '${CURRENT_TASK_AGENT_TYPE}'. Failing task #${fail_id}." >&2
            _post_role_session_no_op "$fail_id" \
                "agent-type-fetch-failed:${CURRENT_TASK_AGENT_TYPE}"
            _reset_task_vars
            return
        fi
    fi

    local task_id_before="$CURRENT_TASK_ID"

    set +e
    _run_daisy_chain "$task_id_before"
    CHAIN_EXIT=$?
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
    _reset_task_vars

    # Check if agent has been stopped or paused
    local agent_status
    agent_status=$(_get_agent_status)
    if [ "$agent_status" = "stopping" ]; then
        echo "Agent deregistered — shutting down."
        PUMP_STATUS="stop"
        return
    fi

    if [ "$agent_status" = "paused" ]; then
        echo "Agent is paused. Waiting for resume..."
        if ! _wait_while_paused; then
            echo "Agent deregistered — shutting down."
            PUMP_STATUS="stop"
            return
        fi
    fi

    echo ""
    echo "=== Daisy-chain complete (chain exit $CHAIN_EXIT). Polling for next task... ==="
    echo ""
}
