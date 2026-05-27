#!/bin/bash
# container/lib/arbitrator-dispatch.sh — Phase 7 arbitrator dispatch.
# Sourced by run-claude.sh when DAISY_CHAIN_ROLE=arbitrator; do not execute
# directly.
#
# When the daisy-chain selects role 'arbitrator' (status = `arbitrating`),
# `_run_claude` defers to `_run_arbitrator_dispatch` here. This module:
#
#   1. Reads the task's pending arbitration trigger via GET /tasks/:id.
#   2. Builds a per-trigger prompt naming the plan path, the review-cycle
#      database endpoint (GET /tasks/:id/reviews/:cycle — reviews are the store
#      of record; there are no scratch `consolidated.md` files), the engineer's
#      commit log, and the reviewer skill definitions.
#   3. Launches a single read-only `claude -p` subprocess with scoped tools
#      (no Edit/Write) and explicit Opus model.
#   4. Captures stdout to .scratch/arbitrations/<task-id>/<trigger>.md.tmp;
#      atomic-renames to .md on clean exit.
#
# The arbitrator session is responsible for posting its own `POST
# /tasks/:id/arbitrations` call. This dispatch script does NOT post on the
# agent's behalf. The arbitration POST handler in the coordination server
# performs the FSM transition atomically with the arbitrationRuns insert; a
# successful POST drives the task to complete / revising / failed.
#
# A second arbitration POST for the same (taskId, trigger) returns 409 from
# the server. The arbitrator agent is instructed (see container-arbitrator-ue.md)
# to log the conflict to its captured output and **exit 0** on 409 — NOT
# non-zero. The dispatch therefore sees a clean exit, the task's status
# remains `arbitrating` (no transition was posted), and the daisy-chain's
# role_session_no_op detector at pump-loop.sh fires
# (sess_exit == 0 && post_status == last_status) and posts
# role_session_no_op → failed. This is the intended brake against arbitration
# loops; the alternative (agent exits non-zero) would trip the pump-loop's
# non-zero-exit bail-out at pump-loop.sh and strand the task in `arbitrating`.

# ── Internal helpers ────────────────────────────────────────────────────────

# Fetch fresh task JSON. Echoes the body on stdout, empty on failure.
_arb_fetch_task() {
    local task_id="$1"
    _curl_server -sf "${SERVER_URL}/tasks/${task_id}" --max-time 10 2>/dev/null \
        || echo ""
}

# Build the prompt body shared by both triggers — header naming task / plan /
# trigger, plus the section pointing at the reviewer skill definitions. The
# per-trigger sections (cycle-exhausted lists prior consolidated.mds; contradiction
# names the two findings) are appended by the caller.
#
# SECURITY: server-derived strings (task_title, source_path, trigger) flow
# through printf %s splices only — no shell parsing of values. The static
# instruction body is emitted via a NON-EXPANDING heredoc (<<'PROMPT').
_arb_build_prompt_header() {
    local task_id="$1"
    local trigger="$2"
    local task_title="$3"
    local source_path="$4"

    local plan_display="${source_path:-<inline task — no plan file>}"

    printf 'You are the **arbitrator** for task %s.\n\nTASK_ID: %s\nTASK_TITLE: %s\nPLAN_PATH: %s\nARBITRATION_TRIGGER: %s\n\n' \
        "$task_id" "$task_id" "$task_title" "$plan_display" "$trigger"

    cat <<'PROMPT'
## Your mandate

You are the singleton tiebreaker for this task. The trigger above names why
you were summoned. Read your composed skills for review-process and
domain knowledge; read your system prompt for the FSM contract and exact
POST payload shapes.

## Reviewer mandates

When adjudicating, consult the per-reviewer skill definitions so you know
each reviewer's narrow mandate:

  Read .compiled-agents/container-safety-reviewer-ue.md
  Read .compiled-agents/container-reviewer-ue.md           (correctness)
  Read .compiled-agents/container-decomposition-reviewer-ue.md

These name what each reviewer can legitimately demand. A finding outside the
reviewer's mandate is not load-bearing — feel free to retire it (on a
contradiction ruling) or treat it as stylistic noise (on a cycle-exhausted
approve).

## Tool scope

You have read-only tools: Read, Grep, Glob, and a narrow Bash allowlist
(`git diff`, `git log`, `git show`, `wc`, `ls`, `curl`). `curl` is permitted
solely so you can POST your final ruling to the coordination server. You
CANNOT Edit, Write, or run broad Bash. If you find yourself wanting to edit
a file, you are out of mandate — re-scope to ruling on what is in front of
you. WebFetch is intentionally excluded; you work exclusively from local
plan / commit / review-markdown files.

PROMPT
}

# Append cycle-exhausted-specific context to the prompt: names every prior
# review cycle's database endpoint plus the engineer's commit log. Reviews are
# the store of record (review_runs + review_findings); the arbitrator GETs each
# cycle from the server rather than reading scratch files.
_arb_append_cycle_exhausted_context() {
    local task_id="$1"
    local files_csv="$2"
    local review_cycle_count="$3"

    local files_display="${files_csv:-<use git diff origin/<branch>..HEAD --name-only>}"
    # reviewing→revising incremented reviewCycleCount before the reroute to
    # arbitrating, so the highest reviewed cycle is review_cycle_count - 1.
    local last_cycle="?"
    if [[ "$review_cycle_count" =~ ^[0-9]+$ ]] && [ "$review_cycle_count" -gt 0 ]; then
        last_cycle=$(( review_cycle_count - 1 ))
    fi

    printf '## Cycle-exhausted inputs\n\nThe task has run the full review-cycle budget and reviewers still hold open BLOCKING findings. Reviews live in the database (verdict + structured findings per reviewer per cycle). Your inputs:\n\n- Every prior review cycle, read in order from cycle 0 to cycle %s:\n\n' "$last_cycle"

    printf '      curl -s ${SERVER_URL}/tasks/%s/reviews/0\n      ... through ...\n      curl -s ${SERVER_URL}/tasks/%s/reviews/%s\n\n' "$task_id" "$task_id" "$last_cycle"

    printf -- '- Convergence check (load-bearing — shows whether the engineer is converging or churning): compare the findings in cycle %s against the cycle before it.\n\n' "$last_cycle"

    printf -- '- Engineer commit log for this task:\n\n      Bash(git log --oneline origin/main..HEAD -- %s)\n\n' "$files_display"

    printf -- '- Changed files for this task: %s\n\n' "$files_display"

    cat <<'PROMPT'
## Permitted rulings on cycle-exhausted

You MAY rule:
- `approve`  — the remaining BLOCKINGs are stylistic noise or have been
               effectively addressed despite the reviewer's continued
               objection; convergence has been achieved.
- `escalate` — substantive concerns remain that require operator judgment.

You MAY NOT rule `rule` on this trigger — there is no per-finding
contradiction to resolve. The server rejects `rule` here with HTTP 400.

PROMPT
}

# Append contradiction-specific context to the prompt: points at the most
# recent review cycle in the database (verdicts + structured findings for every
# reviewer) so the arbitrator can locate the two conflicting findings.
_arb_append_contradiction_context() {
    local task_id="$1"
    local files_csv="$2"
    local review_cycle_count="$3"

    local files_display="${files_csv:-<use git diff origin/<branch>..HEAD --name-only>}"
    # The most recent reviewed cycle is review_cycle_count - 1 (reviewing→revising
    # incremented the counter on the hop that produced the findings in play).
    local last_cycle="?"
    if [[ "$review_cycle_count" =~ ^[0-9]+$ ]] && [ "$review_cycle_count" -gt 0 ]; then
        last_cycle=$(( review_cycle_count - 1 ))
    fi

    cat <<'PROMPT'
## Contradiction inputs

The engineer detected two findings that cannot both be satisfied (e.g. one
demands a split, another demands a lock-together). Your inputs:

- The most recent review cycle from the database (every reviewer's verdict,
  rawMarkdown, and structured findings — each finding carries its own id):

PROMPT

    printf '      curl -s ${SERVER_URL}/tasks/%s/reviews/%s\n\n' "$task_id" "$last_cycle"

    printf -- '- Changed files for this task: %s\n\n' "$files_display"

    cat <<'PROMPT'
The engineer's contradiction-trigger POST named the two finding IDs in the
task's `progress_log` field (read GET /tasks/<id>'s progressLog). Cross-
reference them against the `findings[].id` values in the reviews response above.
Identify both findings, quote them verbatim in your `rulingMarkdown`, and pick
which one survives.

## Permitted rulings on contradiction

You MAY rule:
- `approve`  — neither finding is load-bearing; the engineer's existing
               code is acceptable as-is.
- `rule`     — one finding is upheld, the other is retired this cycle.
               REQUIRED: `contradictionResolution = { upheldFindingId,
               retiredFindingId, rationale }`. ALSO REQUIRED: write a
               separate addendum file at
               `.scratch/arbitrations/<task-id>/contradiction-ruling.md`
               BEFORE posting (see the addendum-file convention in your
               system prompt).
- `escalate` — both findings are legitimately load-bearing and the operator
               must intervene.

PROMPT
}

# ── Public entry ────────────────────────────────────────────────────────────

# _run_arbitrator_dispatch <task-id>
#
# Called by `_run_claude` when DAISY_CHAIN_ROLE=arbitrator. Returns 0 on a
# clean exit from the arbitrator claude subprocess (the agent's own POST is
# what drives the FSM transition; this wrapper only invokes the binary and
# captures output). Returns non-zero on any pre-flight failure (cannot fetch
# task, malformed task id, missing compiled agent).
_run_arbitrator_dispatch() {
    local task_id="$1"

    if [[ ! "$task_id" =~ ^[0-9]+$ ]]; then
        echo "ERROR: arbitrator-dispatch: non-numeric task_id '${task_id}'" >&2
        return 1
    fi

    # Fetch task state to read the pending trigger.
    local task_json
    task_json=$(_arb_fetch_task "$task_id")
    if [ -z "$task_json" ]; then
        echo "ERROR: arbitrator-dispatch: could not fetch task ${task_id}" >&2
        return 1
    fi

    local status trigger task_title source_path files_csv review_cycle_count
    status=$(echo "$task_json"      | jq -r '.status                       // empty')
    trigger=$(echo "$task_json"     | jq -r '.arbitrationPendingTrigger   // ""'    | tr -d '\n')
    task_title=$(echo "$task_json"  | jq -r '.title                        // ""'    | tr -d '\n')
    source_path=$(echo "$task_json" | jq -r '.sourcePath                   // ""'    | tr -d '\n')
    files_csv=$(echo "$task_json"   | jq -r '(.files // []) | join(", ")')
    review_cycle_count=$(echo "$task_json" | jq -r '.reviewCycleCount      // 0')
    if ! [[ "$review_cycle_count" =~ ^[0-9]+$ ]]; then
        review_cycle_count=0
    fi

    if [ "$status" != "arbitrating" ]; then
        echo "ERROR: arbitrator-dispatch: task ${task_id} is not in 'arbitrating' (status='${status}')" >&2
        return 1
    fi

    # Validate trigger against the known enum before splicing into a file path.
    case "$trigger" in
        review_cycle_budget_exhausted|reviewer_contradiction)
            ;;
        *)
            echo "ERROR: arbitrator-dispatch: task ${task_id} has invalid/missing arbitrationPendingTrigger '${trigger}'" >&2
            return 1
            ;;
    esac

    # Phase 7 cycle 1 (safety W1): allowlist-scrub server-derived strings
    # before they enter the arbitrator prompt. Reuses the shared scrub helpers
    # from run-claude.sh (which sources this file), keeping the allowlist
    # consistent with the engineer-prompt scrub posture. The allowlist regex is
    # `^[-A-Za-z0-9_./ ]+$` — alnum, hyphen, underscore, dot, slash, space —
    # so any shell metacharacter or control byte in a hostile title / path
    # collapses to empty before reaching the prompt body.
    #
    # task_title may legitimately contain characters outside this set (colons,
    # parens, etc.). On reject the title degrades to empty in the prompt; the
    # arbitrator can still read task context from the plan and reviews.
    task_title=$(_scrub_prompt_path_field "$task_title" "task_title") || true
    source_path=$(_scrub_prompt_path_field "$source_path" "source_path") || true
    files_csv=$(_scrub_prompt_path_csv "$files_csv" "files_csv[entry]")

    echo "arbitrator-dispatch: task=${task_id} status=${status} trigger=${trigger}"

    # Resolve the arbitrator agent basename from the daisy-chain roles file.
    # The roles file is the shallow merge of the project's agentRoles (from
    # scaffold.config.json) and the task's per-row agent_roles_override. When
    # the project has not configured any arbitrator at all, we fall back to
    # the global `fallback-arbitrator` definition — a domain-agnostic agent
    # that rules from the FSM contract and git history alone. The server
    # serves this definition the same way as any other; the container's
    # _ensure_agent_type call below fetches and caches it on first miss.
    local agent_basename=""
    if [ -n "${DAISY_CHAIN_ROLES_FILE:-}" ] && [ -f "$DAISY_CHAIN_ROLES_FILE" ]; then
        agent_basename=$(jq -r '.arbitrator // empty' "$DAISY_CHAIN_ROLES_FILE" 2>/dev/null) \
            || agent_basename=""
    fi
    if [ -z "$agent_basename" ]; then
        agent_basename="fallback-arbitrator"
    fi
    if ! _is_safe_name "$agent_basename"; then
        echo "ERROR: arbitrator-dispatch: arbitrator agent basename '${agent_basename}' contains invalid characters" >&2
        return 1
    fi

    # Best-effort: ensure the compiled agent is cached before spawn.
    _ensure_agent_type "$agent_basename" >/dev/null 2>&1 || true

    local agent_md="/home/claude/.claude/agents/${agent_basename}.md"
    if [ ! -f "$agent_md" ]; then
        echo "ERROR: arbitrator-dispatch: compiled agent '${agent_basename}' not found at ${agent_md}" >&2
        return 1
    fi
    local agent_body
    agent_body=$(cat "$agent_md")

    # Build the per-trigger prompt.
    local prompt
    prompt="$(_arb_build_prompt_header "$task_id" "$trigger" "$task_title" "$source_path")"
    case "$trigger" in
        review_cycle_budget_exhausted)
            prompt="${prompt}$(_arb_append_cycle_exhausted_context "$task_id" "$files_csv" "$review_cycle_count")"
            ;;
        reviewer_contradiction)
            prompt="${prompt}$(_arb_append_contradiction_context "$task_id" "$files_csv" "$review_cycle_count")"
            ;;
    esac

    # Scratch directory for arbitrator artefacts. The atomic-rename pattern
    # (.tmp → .md on clean exit) guards against partial-write on mid-session
    # crash, mirroring the reviewer-fanout convention.
    local scratch_dir="/workspace/.scratch/arbitrations/${task_id}"
    mkdir -p "$scratch_dir"
    local tmpfile="${scratch_dir}/${trigger}.md.tmp"
    local finalfile="${scratch_dir}/${trigger}.md"
    # Phase 7 cycle 1 (safety B2): stderr goes to /dev/null rather than a
    # persistent log file in the scratch dir. The reviewer-fanout history shows
    # the .stderr file is rarely useful for diagnosis and risks leaking
    # diagnostic info about the run.

    _post_status "working"

    # Launch the arbitrator. Scoped tools mirror the reviewer-fanout posture
    # plus two *narrowed* `curl` permissions: a read-only GET of THIS task's
    # reviews (the store of record it adjudicates from) and the agent's own POST
    # /arbitrations. We explicitly name the Opus model here because the plan
    # calls this out as load-bearing — the arbitrator runs at most twice per
    # task and is the most consequential single judgment in the FSM. WebFetch
    # is excluded; the arbitrator works exclusively from local plan / commit
    # history plus the task's own review rows.
    #
    # SECURITY (Phase 7 cycle 1, safety B1): both curl permissions are bound to
    # THIS task on THIS server only. The patterns below substitute ${SERVER_URL}
    # and ${task_id} at script time (bash expansion, before claude sees the
    # string), so the literal constraints claude enforces are fully-qualified
    # URL prefixes anchored to ${SERVER_URL}/tasks/${task_id}/reviews (GET) and
    # ${SERVER_URL}/tasks/${task_id}/arbitrations (POST). The trailing `*`
    # permits the curl flags / body / headers that follow the URL in the agent's
    # invocation but not a different endpoint, task, or host. The reviews
    # endpoint is read-only and task-scoped, so widening to it does not expand
    # the arbitrator's write surface.
    #
    # If the underlying allowlist engine in any future Claude Code release
    # stops honouring URL-constrained globs and falls back to literal-prefix
    # matching only, the agent's curl will be denied (since it would no
    # longer match the constructed pattern) and the arbitration will be
    # surfaced as `role_session_no_op` rather than silently succeeding. The
    # mitigation in that failure mode is the post-hoc server-side audit:
    # every successful POST writes a row to `arbitrationRuns` that the
    # operator can review.
    local curl_pattern="curl * ${SERVER_URL}/tasks/${task_id}/arbitrations*"
    local reviews_pattern="curl * ${SERVER_URL}/tasks/${task_id}/reviews*"
    echo "arbitrator-dispatch: launching claude (agent=${agent_basename}, model=opus)"
    set +e
    claude \
        --dangerously-skip-permissions \
        --allowed-tools "Read,Grep,Glob,Bash(git diff:*,git log:*,git show:*,wc:*,ls:*),Bash(${reviews_pattern}),Bash(${curl_pattern})" \
        -p "$prompt" \
        --append-system-prompt "$agent_body" \
        --output-format json \
        --model claude-opus-4-7 \
        --mcp-config /home/claude/.claude/mcp.json \
        > "$tmpfile" 2>/dev/null
    local rc=$?
    set -e

    if [ "$rc" -ne 0 ]; then
        echo "arbitrator-dispatch: claude exited ${rc}" >&2
        # Leave the .tmp file in place for diagnosis; do NOT rename.
        _post_status "error"
        return "$rc"
    fi

    # Atomic rename guards against partial-write on mid-session crash.
    if ! mv "$tmpfile" "$finalfile" 2>/dev/null; then
        echo "arbitrator-dispatch: failed to rename ${tmpfile} → ${finalfile}" >&2
        _post_status "error"
        return 1
    fi

    echo "arbitrator-dispatch: wrote ${finalfile}"
    _post_status "done"
    return 0
}
