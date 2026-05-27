#!/bin/bash
# container/lib/reviewer-fanout.sh — Phase 6 parallel reviewer dispatch.
# Sourced by entrypoint.sh; do not execute directly.
#
# When the daisy-chain selects role 'reviewer-fanout' (status ∈ {built,
# reviewing}), `_run_claude` defers to `_run_reviewer_fanout` here instead of
# launching a single claude session. This module:
#
#   1. Drives the `built → reviewing` transition (or skips it on a recovery
#      re-entry where status is already `reviewing`).
#   2. Reads the resolved `reviewers` map from $DAISY_CHAIN_ROLES_FILE.
#   3. Skips reviewer roles that already posted runs for this (task, cycle).
#   4. Spawns the remaining reviewers in parallel, each as a scoped claude
#      subprocess with no Edit/Write tools. Per-role stdout lands in
#      `.scratch/reviews/<task-id>/cycle-<N>/<role>.md.tmp`; on success, the
#      tmpfile is atomic-renamed to `<role>.md`.
#   5. Retries up to 2 times any role whose claude crashed or that did not
#      produce a /reviews row server-side. After 2 retries with no row, the
#      wrapper returns non-zero without transitioning the task — the task stays
#      in `reviewing` and the next container's startup-resume probe re-enters
#      this dispatcher. Infrastructure problems should not terminalize tasks
#      whose engineering work is already committed.
#   6. After all reviewer rows are present, posts the per-role verdict merge
#      (`reviewing → reviewing` self-loop with payload {reviewerRole, verdict})
#      so reviewerVerdicts is populated for the dashboard.
#   7. Computes the findings-based accept/revise decision from the authoritative
#      review rows and posts the final transition: `completed` on acceptance,
#      otherwise `revising`. No workspace pointer is written — reviews live in
#      the database (review_runs + review_findings); the engineer reads them via
#      GET /tasks/:id/reviews/:cycle. The decision mirrors classifyReview()
#      server-side (server/src/review-decision.ts), which re-derives the same
#      verdict and gates the transition.
#
# The fanout itself owns final transitions; reviewers only POST /tasks/:id/reviews.

# ── Internal helpers ────────────────────────────────────────────────────────

# POST /tasks/:id/transition with the supplied JSON body. Returns curl exit code
# on stdout via the function's exit code (0 = success / non-zero = failed).
# Errors are intentionally non-fatal — the daisy-chain handles unchanged-status
# detection in pump-loop.sh as a fallback.
_rfan_post_transition() {
    local task_id="$1"
    local body="$2"
    _curl_server -s -X POST "${SERVER_URL}/tasks/${task_id}/transition" \
        -H "Content-Type: application/json" \
        -d "$body" \
        --max-time 15 >/dev/null 2>&1
}

# Fetch fresh task JSON. Echoes the body on stdout, empty on failure.
_rfan_fetch_task() {
    local task_id="$1"
    _curl_server -sf "${SERVER_URL}/tasks/${task_id}" --max-time 10 2>/dev/null \
        || echo ""
}

# Fetch the per-cycle review-runs view. Echoes the JSON body on stdout, empty
# on failure.
_rfan_fetch_cycle_runs() {
    local task_id="$1"
    local cycle="$2"
    _curl_server -sf "${SERVER_URL}/tasks/${task_id}/reviews/${cycle}" \
        --max-time 10 2>/dev/null \
        || echo ""
}

# Build the per-role reviewer prompt. Reviewer is told its role, task id,
# cycle, plan path, and changed-files list, plus the JSON-shadow API contract.
# It is NOT shown other reviewers' findings or the consolidated file (Phase 6
# step 6 — reviewers are blind to each other).
#
# SECURITY: two-layer posture. Layer 1 — the caller `_run_reviewer_fanout`
# allowlist-scrubs task_title, source_path, and files_csv via
# `_scrub_prompt_path_field` / `_scrub_prompt_path_csv` BEFORE invoking this
# prompt builder, so values arrive here already filtered to the path
# allowlist (alnum/underscore/dot/slash/space/hyphen). Layer 2 — defence in
# depth at this site: we still emit the variable header via printf (only %s
# substitution, no shell parsing of values) and emit the static body via a
# NON-EXPANDING heredoc (`<<'PROMPT'`), so even if the upstream scrub were
# bypassed the values could not reach a shell expansion site here. The only
# locally-validated values spliced via printf are task_id (numeric-checked
# at line 252), cycle (numeric-checked at line 256), and role
# (_is_safe_name-checked at line 327).
_rfan_build_reviewer_prompt() {
    local task_id="$1"
    local cycle="$2"
    local role="$3"
    local source_path="$4"
    local files_csv="$5"
    local task_title="$6"

    local plan_display="${source_path:-<inline task — no plan file>}"
    local files_display="${files_csv:-<use git diff origin/<branch>..HEAD --name-only>}"

    # Header: only %s splices, no shell parsing of server-derived values.
    printf 'You are running as the **%s** reviewer for task %s, review cycle %s.\n\nTASK_ID: %s\nTASK_TITLE: %s\nPLAN_PATH: %s\nREVIEWER_ROLE: %s\nREVIEW_CYCLE: %s\nCHANGED_FILES: %s\n\n' \
        "$role" "$task_id" "$cycle" \
        "$task_id" "$task_title" "$plan_display" \
        "$role" "$cycle" "$files_display"

    # Body: non-expanding heredoc. ${SERVER_URL}, ${role}, ${task_id},
    # ${cycle} below are LITERAL placeholders shown to the reviewer — the
    # reviewer's curl hook (inject-agent-header.sh) supplies the real
    # SERVER_URL at POST time, and the role/cycle/task_id are also visible to
    # the reviewer in the header section above. Keeping them literal here
    # ensures no server-controlled string can ever reach a shell expansion
    # site at function-call time.
    cat <<'PROMPT'
## What to review

Read the plan (if PLAN_PATH is set) and the changed files. Apply your domain
review protocol exactly as defined by your composed skills. Produce the
markdown report mandated by review-output-schema (BLOCKING and NOTE tiers
only — the WARNING tier is retired). Do not paraphrase another reviewer's
findings; you cannot see them.

## Tool scope

You have read-only tools: Read, Grep, Glob, and a narrow Bash allowlist
(`git diff`, `git log`, `wc`, `ls`, `curl`). `curl` is permitted
solely so you can POST your final verdict to the coordination server (see
"Final action — POST /reviews" below). You CANNOT Edit, Write, or run
broad Bash. If you find yourself needing to edit a file, that is a finding
to report — not an action you can take.

## Output

Emit your markdown review report on stdout. Then emit the JSON shadow block
exactly as defined in your review-output-schema skill (cycle / reviewerRole /
verdict / rawMarkdown / findings[]).

## Final action — POST /reviews

Your LAST action before exiting is to POST your verdict and findings to:

  POST ${SERVER_URL}/tasks/${TASK_ID}/reviews
  Content-Type: application/json
  Body: {
    "cycle": ${REVIEW_CYCLE},
    "reviewerRole": "${REVIEWER_ROLE}",
    "verdict": "approve" | "request_changes" | "out_of_scope",
    "rawMarkdown": "<full markdown report verbatim>",
    "findings": [ ...structured findings... ]
  }

(Use the TASK_ID, REVIEW_CYCLE, and REVIEWER_ROLE values from the header
above when constructing the URL and body.)

The standard `X-Agent-Name` and `X-Project-Id` headers are injected by the
container's curl hook. Do NOT POST /transition — the reviewer-fanout owns that
transition. Do NOT POST /reviews more than once for this (task, cycle, role)
triple — the server returns 409 on duplicate posts.

After your POST returns 200, exit cleanly.
PROMPT
}

# Run a single reviewer subprocess. Captures stdout to <role>.md.tmp; on a
# clean exit (claude exit 0), atomic-renames to <role>.md. Returns 0 on
# successful rename, non-zero on any failure. The `set +e` block guards the
# parallel parent against bailing on an individual reviewer failure.
_rfan_spawn_reviewer() {
    local task_id="$1"
    local cycle="$2"
    local role="$3"
    local agent_basename="$4"
    local source_path="$5"
    local files_csv="$6"
    local task_title="$7"
    local scratch_dir="$8"

    local prompt
    prompt=$(_rfan_build_reviewer_prompt \
        "$task_id" "$cycle" "$role" "$source_path" "$files_csv" "$task_title")

    local tmpfile="${scratch_dir}/${role}.md.tmp"
    local finalfile="${scratch_dir}/${role}.md"
    local agent_md="/home/claude/.claude/agents/${agent_basename}.md"

    # The append-system-prompt path must exist; if the compiled agent is
    # missing, _ensure_agent_type should have fetched it before fanout entered.
    if [ ! -f "$agent_md" ]; then
        echo "ERROR: reviewer-fanout: compiled agent '${agent_basename}' not found at ${agent_md}" >&2
        return 1
    fi

    local agent_body
    agent_body=$(cat "$agent_md")

    # stdout → tmpfile (becomes .md after rename); stderr → separate log file
    # so claude's diagnostic noise does not contaminate the consolidated.md
    # that humans and the engineer revise from.
    local stderr_log="${scratch_dir}/${role}.stderr"
    set +e
    claude \
        --dangerously-skip-permissions \
        --allowed-tools "Read,Grep,Glob,Bash(git diff:*,git log:*,wc:*,ls:*,curl:*)" \
        -p "$prompt" \
        --append-system-prompt "$agent_body" \
        --output-format json \
        --mcp-config /home/claude/.claude/mcp.json \
        > "$tmpfile" 2> "$stderr_log"
    local rc=$?
    set -e

    if [ "$rc" -ne 0 ]; then
        echo "reviewer-fanout: role '${role}' claude exited ${rc}" >&2
        return "$rc"
    fi

    # Atomic rename guards against partial-write on mid-session crash. If the
    # rename fails (e.g. tmpfile vanished), bubble the failure up.
    mv "$tmpfile" "$finalfile" 2>/dev/null || return 1
    return 0
}

# Read a reviewer's verdict from the server-side runs row set. Echoes the
# verdict string on stdout, empty if the role has no row.
_rfan_verdict_for_role() {
    local runs_json="$1"
    local role="$2"
    echo "$runs_json" | jq -r --arg r "$role" \
        '(.runs // []) | map(select(.reviewerRole == $r)) | (.[0].verdict // "")' \
        2>/dev/null \
        || echo ""
}

# ── Public entry ────────────────────────────────────────────────────────────

# _run_reviewer_fanout <task-id> <cycle>
#
# Called by `_run_claude` when DAISY_CHAIN_ROLE=reviewer-fanout. Returns 0 on
# success (final transition posted), non-zero on infrastructure failure (in
# which case the task has already been transitioned to `failed`).
_run_reviewer_fanout() {
    local task_id="$1"
    local cycle="$2"

    if [[ ! "$task_id" =~ ^[0-9]+$ ]]; then
        echo "ERROR: reviewer-fanout: non-numeric task_id '${task_id}'" >&2
        return 1
    fi
    if [[ ! "$cycle" =~ ^[0-9]+$ ]]; then
        # Daisy-chain cycle is the loop counter, not the review cycle. We use
        # it for log scoping; if it's malformed, default to 0 rather than
        # wedging the fanout.
        cycle=0
    fi

    if [ -z "${DAISY_CHAIN_ROLES_FILE:-}" ] || [ ! -f "$DAISY_CHAIN_ROLES_FILE" ]; then
        echo "ERROR: reviewer-fanout: DAISY_CHAIN_ROLES_FILE not set or missing" >&2
        return 1
    fi

    # Fetch fresh task state.
    local task_json status source_path task_title files_csv review_cycle_count
    task_json=$(_rfan_fetch_task "$task_id")
    if [ -z "$task_json" ]; then
        echo "ERROR: reviewer-fanout: could not fetch task ${task_id}" >&2
        return 1
    fi
    status=$(echo "$task_json"      | jq -r '.status                // empty')
    source_path=$(echo "$task_json" | jq -r '.sourcePath            // ""'    | tr -d '\n')
    task_title=$(echo "$task_json"  | jq -r '.title                 // ""'    | tr -d '\n')
    files_csv=$(echo "$task_json"   | jq -r '(.files // []) | join(", ")')
    review_cycle_count=$(echo "$task_json" | jq -r '.reviewCycleCount // 0')
    if ! [[ "$review_cycle_count" =~ ^[0-9]+$ ]]; then
        review_cycle_count=0
    fi

    # Phase 7 cycle 2 (decomp W2): allowlist-scrub server-derived strings
    # before they enter the per-reviewer prompt. Mirrors the arbitrator
    # dispatch — both dispatchers pull the same triple (task_title,
    # source_path, files_csv) from the same GET /tasks/:id shape, so they
    # must both scrub to keep the safety posture consistent. The allowlist
    # regex is `^[-A-Za-z0-9_./ ]+$`; values that fail collapse to empty in
    # the prompt body (reviewers can still read task context from the plan
    # and `git diff`).
    task_title=$(_scrub_prompt_path_field "$task_title" "task_title") || true
    source_path=$(_scrub_prompt_path_field "$source_path" "source_path") || true
    files_csv=$(_scrub_prompt_path_csv "$files_csv" "files_csv[entry]")

    # The /reviews endpoints are keyed on the review cycle (server-side
    # reviewCycleCount), not the daisy-chain loop counter. Both happen to be 0
    # for the first cycle, but they diverge once a `revising → engineering →
    # built → reviewing` revolution happens.
    local review_cycle="$review_cycle_count"

    echo "reviewer-fanout: task=${task_id} status=${status} reviewCycle=${review_cycle} (daisy-chain cycle ${cycle})"

    # Step 1: built → reviewing transition. On a recovery re-entry where status
    # is already `reviewing`, skip — re-posting `reviewing` would reset
    # reviewerVerdicts to {} and clobber any merges already accumulated.
    if [ "$status" = "built" ]; then
        local enter_body
        enter_body=$(jq -nc '{to: "reviewing"}')
        if ! _rfan_post_transition "$task_id" "$enter_body"; then
            echo "WARNING: reviewer-fanout: built→reviewing transition POST returned error; continuing on assumption server saw it" >&2
        fi
    elif [ "$status" != "reviewing" ]; then
        echo "ERROR: reviewer-fanout: unexpected status '${status}' (expected built or reviewing)" >&2
        return 1
    fi

    # Step 2: declared reviewer roles from the resolved roles file.
    # roles_file format is the merged effectiveAgentRoles: {engineer, arbitrator,
    # reviewers: {role: agent-basename}}.
    local declared_roles
    declared_roles=$(jq -r '.reviewers // {} | keys[]' "$DAISY_CHAIN_ROLES_FILE" 2>/dev/null) \
        || declared_roles=""
    if [ -z "$declared_roles" ]; then
        echo "ERROR: reviewer-fanout: no declared reviewer roles in roles file" >&2
        # No reviewers is invalid per Phase 1 schema; fail the task rather than
        # silent-passing.
        local body
        body=$(jq -nc '{to: "failed", payload: {failureReason: "role_session_no_op", failureDetail: "reviewer-fanout: declared reviewers map empty"}}')
        _rfan_post_transition "$task_id" "$body"
        return 1
    fi

    # Validate every declared role against _is_safe_name before splicing into
    # paths or system prompts.
    local role
    local -a all_roles=()
    for role in $declared_roles; do
        if ! _is_safe_name "$role"; then
            echo "ERROR: reviewer-fanout: declared role '${role}' contains invalid characters" >&2
            return 1
        fi
        all_roles+=("$role")
    done

    local scratch_dir="/workspace/.scratch/reviews/${task_id}/cycle-${review_cycle}"
    mkdir -p "$scratch_dir"

    # ── Recovery skip + per-role retry loop ─────────────────────────────────
    # For each declared role, if the server already has a /reviews row for
    # (task, review_cycle, role), do not respawn it. Otherwise spawn it; if
    # the spawn fails or no /reviews row appears, retry up to 2 times.
    local -A retries=()
    for role in "${all_roles[@]}"; do
        retries[$role]=0
    done

    while true; do
        # Fetch current /reviews/:cycle row set to determine the spawn set.
        local cycle_runs
        cycle_runs=$(_rfan_fetch_cycle_runs "$task_id" "$review_cycle")
        local already_posted
        already_posted=$(echo "$cycle_runs" | jq -r '(.runs // [])[].reviewerRole' 2>/dev/null) \
            || already_posted=""

        local -a spawn_set=()
        for role in "${all_roles[@]}"; do
            if ! grep -qx "$role" <<< "$already_posted" 2>/dev/null; then
                spawn_set+=("$role")
            fi
        done

        if [ "${#spawn_set[@]}" -eq 0 ]; then
            echo "reviewer-fanout: all declared reviewers have posted /reviews rows."
            break
        fi

        # Retry-budget guard before spawning. If any role has exhausted its
        # retries (>2) and is still in the spawn set, surrender the task without
        # transitioning. It stays in `reviewing` for the next container to
        # resume — terminalizing on an infrastructure problem (auth, network,
        # spawn flag, etc.) would render a clean-built task unrecoverable.
        for role in "${spawn_set[@]}"; do
            if [ "${retries[$role]}" -gt 2 ]; then
                echo "ERROR: reviewer-fanout: role '${role}' exhausted 2 retries with no /reviews row." >&2
                echo "ERROR: reviewer-fanout: surrendering task ${task_id} in 'reviewing' for next container to resume." >&2
                return 1
            fi
        done

        echo "reviewer-fanout: spawning roles: ${spawn_set[*]} (review cycle ${review_cycle})"

        # Resolve agent basename per role and spawn in parallel. set +e so a
        # single reviewer failure doesn't abort the others; the recovery check
        # above will pick up survivors next iteration.
        local -A pids=()
        set +e
        for role in "${spawn_set[@]}"; do
            local agent_basename
            agent_basename=$(jq -r --arg r "$role" \
                '.reviewers[$r] // empty' "$DAISY_CHAIN_ROLES_FILE" 2>/dev/null) \
                || agent_basename=""
            if [ -z "$agent_basename" ] || ! _is_safe_name "$agent_basename"; then
                echo "ERROR: reviewer-fanout: invalid agent basename for role '${role}': '${agent_basename}'" >&2
                # Skip spawn; the post-wait loop below is the single retry-
                # increment site, so a persistently unresolvable role bumps
                # exactly once per iteration. No pre-spawn bump here would
                # cause a double-bump (N1).
                continue
            fi

            # Best-effort: ensure the compiled agent is cached before spawn.
            _ensure_agent_type "$agent_basename" >/dev/null 2>&1 || true

            (
                _rfan_spawn_reviewer \
                    "$task_id" "$review_cycle" "$role" "$agent_basename" \
                    "$source_path" "$files_csv" "$task_title" "$scratch_dir"
                exit $?
            ) &
            pids[$role]=$!
        done

        # Wait for all backgrounded spawns. Capture per-role exit codes.
        local -A spawn_exits=()
        for role in "${!pids[@]}"; do
            wait "${pids[$role]}" 2>/dev/null
            spawn_exits[$role]=$?
        done
        set -e

        # Bump retry counter for every role we tried this iteration (whether
        # claude succeeded or not — the authoritative success signal is the
        # server-side /reviews row, checked at the top of the next iteration).
        for role in "${spawn_set[@]}"; do
            retries[$role]=$(( ${retries[$role]} + 1 ))
            if [ "${spawn_exits[$role]:-1}" -ne 0 ]; then
                echo "reviewer-fanout: role '${role}' subprocess exited non-zero (attempt ${retries[$role]})" >&2
            fi
        done
    done

    # ── Step 6: per-role verdict merges ────────────────────────────────────
    # Now that every declared reviewer has a /reviews row, refetch and post
    # the reviewing→reviewing self-loop merge for each role so reviewerVerdicts
    # is populated. Idempotent: server merges single-key updates without
    # touching other keys.
    local final_runs
    final_runs=$(_rfan_fetch_cycle_runs "$task_id" "$review_cycle")
    if [ -z "$final_runs" ]; then
        echo "ERROR: reviewer-fanout: could not refetch cycle runs after spawn loop" >&2
        return 1
    fi

    local verdict
    for role in "${all_roles[@]}"; do
        verdict=$(_rfan_verdict_for_role "$final_runs" "$role")
        if [ -z "$verdict" ]; then
            echo "ERROR: reviewer-fanout: no verdict for role '${role}' even after spawn loop completed" >&2
            return 1
        fi
        local merge_body
        merge_body=$(jq -nc \
            --arg role "$role" \
            --arg v    "$verdict" \
            '{to: "reviewing", payload: {reviewerRole: $role, verdict: $v}}')
        if ! _rfan_post_transition "$task_id" "$merge_body"; then
            echo "WARNING: reviewer-fanout: verdict-merge POST for role '${role}' returned error; continuing." >&2
        fi
    done

    # ── Step 7: findings-based final transition ────────────────────────────
    # The accept/revise decision is computed from the authoritative review rows
    # (verdict + per-reviewer finding tallies), NOT verdicts alone. It mirrors
    # classifyReview() in server/src/review-decision.ts — the server re-derives
    # the same verdict from review_runs/review_findings and gates the transition,
    # so the two layers agree. A revision round is triggered if ANY of:
    #   1. a reviewer returned request_changes
    #   2. a reviewer raised >= 3 findings (BLOCKING + NOTE both count)
    #   3. >= 2 reviewers raised at least one finding
    #   4. a reviewer raised a BLOCKING finding (backstop for a reviewer who
    #      raised a blocker but did not request changes)
    # Otherwise the work meets the acceptance criteria and is completed. No
    # workspace pointer is written — the engineer reads the reviews from the
    # database via GET /tasks/:id/reviews/:cycle.
    local decision
    decision=$(echo "$final_runs" | jq -r '
        (.runs // []) as $r
        | (($r | any(.verdict == "request_changes"))
           or ($r | any(((.findings // []) | length) >= 3))
           or (($r | map(select(((.findings // []) | length) >= 1)) | length) >= 2)
           or ($r | any((.findings // []) | any(.severity == "BLOCKING"))))
        | if . then "revise" else "accept" end
    ' 2>/dev/null) || decision=""

    if [ "$decision" != "revise" ] && [ "$decision" != "accept" ]; then
        echo "ERROR: reviewer-fanout: could not compute review decision from cycle runs" >&2
        return 1
    fi

    local final_body
    if [ "$decision" = "revise" ]; then
        final_body=$(jq -nc '{to: "revising"}')
        echo "reviewer-fanout: revision triggered → revising"
    else
        final_body=$(jq -nc '{to: "completed"}')
        echo "reviewer-fanout: acceptance criteria met → completed"
    fi

    if ! _rfan_post_transition "$task_id" "$final_body"; then
        echo "ERROR: reviewer-fanout: final transition POST failed" >&2
        return 1
    fi

    return 0
}
