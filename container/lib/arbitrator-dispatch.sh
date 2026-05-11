#!/bin/bash
# container/lib/arbitrator-dispatch.sh — Phase 7 arbitrator dispatch.
# Sourced by run-claude.sh when DAISY_CHAIN_ROLE=arbitrator; do not execute
# directly.
#
# When the daisy-chain selects role 'arbitrator' (status = `arbitrating`),
# `_run_claude` defers to `_run_arbitrator_dispatch` here. This module:
#
#   1. Reads the task's pending arbitration trigger via GET /tasks/:id.
#   2. Builds a per-trigger prompt naming the plan path, prior cycle
#      `consolidated.md` files, the engineer's commit log, and the reviewer
#      skill definitions.
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

# Append cycle-exhausted-specific context to the prompt: lists every prior
# cycle's consolidated.md plus the engineer's commit log and the diff between
# the last two cycles' consolidated reviews.
_arb_append_cycle_exhausted_context() {
    local task_id="$1"
    local files_csv="$2"

    local files_display="${files_csv:-<use git diff origin/<branch>..HEAD --name-only>}"

    printf '## Cycle-exhausted inputs\n\nThe task has run five review cycles and reviewers still hold open BLOCKING findings. Your inputs:\n\n- Prior consolidated reviews:\n'

    # List every cycle directory that exists. We do not glob from inside the
    # heredoc — the agent reads the directory itself via Glob/Bash(ls).
    printf '\n      Glob .scratch/reviews/%s/cycle-*/consolidated.md\n      Read each in order from cycle-1 to cycle-N.\n\n' "$task_id"

    printf -- '- Diff between final two cycles (load-bearing — shows whether the engineer is converging or churning):\n\n'
    printf '      diff .scratch/reviews/%s/cycle-N-1/consolidated.md .scratch/reviews/%s/cycle-N/consolidated.md\n\n' "$task_id" "$task_id"

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

# Append contradiction-specific context to the prompt: names the two finding
# IDs (when known) and points at the per-reviewer markdown for the two
# reviewers involved.
_arb_append_contradiction_context() {
    local task_id="$1"
    local files_csv="$2"

    local files_display="${files_csv:-<use git diff origin/<branch>..HEAD --name-only>}"

    cat <<'PROMPT'
## Contradiction inputs

The engineer detected two findings that cannot both be satisfied (e.g. one
demands a split, another demands a lock-together). Your inputs:

- The most recent cycle's consolidated review and per-reviewer markdown:

PROMPT

    printf '      Glob .scratch/reviews/%s/cycle-*/consolidated.md   (use the highest-numbered cycle)\n' "$task_id"
    printf '      Glob .scratch/reviews/%s/cycle-*/*.md              (per-reviewer reports)\n\n' "$task_id"

    printf -- '- Changed files for this task: %s\n\n' "$files_display"

    cat <<'PROMPT'
The engineer's contradiction-trigger POST named the two finding IDs in the
task's `progress_log` field (read GET /tasks/<id>'s progressLog) or in the
most recent consolidated.md. Identify both findings, quote them verbatim in
your `rulingMarkdown`, and pick which one survives.

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

    local status trigger task_title source_path files_csv
    status=$(echo "$task_json"      | jq -r '.status                       // empty')
    trigger=$(echo "$task_json"     | jq -r '.arbitrationPendingTrigger   // ""'    | tr -d '\n')
    task_title=$(echo "$task_json"  | jq -r '.title                        // ""'    | tr -d '\n')
    source_path=$(echo "$task_json" | jq -r '.sourcePath                   // ""'    | tr -d '\n')
    files_csv=$(echo "$task_json"   | jq -r '(.files // []) | join(", ")')

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
    # Falls back to the conventional default if the roles file is absent or
    # missing the key — this keeps a fresh container working even before the
    # operator has configured per-project roles.
    local agent_basename=""
    if [ -n "${DAISY_CHAIN_ROLES_FILE:-}" ] && [ -f "$DAISY_CHAIN_ROLES_FILE" ]; then
        agent_basename=$(jq -r '.arbitrator // empty' "$DAISY_CHAIN_ROLES_FILE" 2>/dev/null) \
            || agent_basename=""
    fi
    if [ -z "$agent_basename" ]; then
        agent_basename="container-arbitrator-ue"
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
            prompt="${prompt}$(_arb_append_cycle_exhausted_context "$task_id" "$files_csv")"
            ;;
        reviewer_contradiction)
            prompt="${prompt}$(_arb_append_contradiction_context "$task_id" "$files_csv")"
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
    # plus a *narrowed* `curl` permission for the agent's own POST
    # /arbitrations. We explicitly name the Opus model here because the plan
    # calls this out as load-bearing — the arbitrator runs at most twice per
    # task and is the most consequential single judgment in the FSM. WebFetch
    # is excluded; the arbitrator works exclusively from local plan / commit /
    # review-markdown files.
    #
    # SECURITY (Phase 7 cycle 1, safety B1): the curl permission is bound to
    # POSTing to the arbitrations endpoint for THIS task on THIS server only.
    # The pattern below substitutes ${SERVER_URL} and ${task_id} at script
    # time (bash expansion, before claude sees the string), so the literal
    # constraint claude enforces is a fully-qualified URL prefix anchored to
    # ${SERVER_URL}/tasks/${task_id}/arbitrations. The trailing `*` permits
    # the curl flags / body / headers that follow the URL in the agent's
    # invocation but not a different endpoint or host.
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
    echo "arbitrator-dispatch: launching claude (agent=${agent_basename}, model=opus)"
    set +e
    claude \
        --allowed-tools "Read,Grep,Glob,Bash(git diff:*,git log:*,git show:*,wc:*,ls:*),Bash(${curl_pattern})" \
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
