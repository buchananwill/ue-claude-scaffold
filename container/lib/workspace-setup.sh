#!/bin/bash
# container/lib/workspace-setup.sh — Clone, checkout, git-exclude, agent snapshot, plugin symlinks.
# Sourced by entrypoint.sh; do not execute directly.

_setup_workspace() {
    # ── Clone from the local bare repo (bind-mounted at /repo.git) ──────────
    git config --global --add safe.directory /repo.git
    git config --global --add safe.directory /workspace

    if [ ! -d /workspace/.git ]; then
        echo "Cloning from local bare repo..."
        git clone /repo.git /workspace --branch "$WORK_BRANCH"
    fi

    cd /workspace

    # Ensure we're on the right branch
    git checkout "$WORK_BRANCH" 2>/dev/null || git checkout -b "$WORK_BRANCH"

    # Pull latest from bare repo (picks up plans merged by the server)
    git fetch origin "$WORK_BRANCH" 2>/dev/null || true
    git reset --hard "origin/${WORK_BRANCH}" 2>/dev/null || true

    # Configure git for container commits
    git config user.email "claude-docker@localhost"
    git config user.name "Claude Code (Docker)"
    git config core.autocrlf false

    # ── Exclude Claude Code runtime metadata from git ───────────────────────
    # Also exclude the .scratch/ trees written by the daisy-chain loop
    # (reviewer transcripts, arbitrator addenda) so they never accidentally
    # land in the agent's commits. We rewrite the file each setup so reruns
    # never accumulate duplicate lines.
    cat > .git/info/exclude <<'EXCL'
.claude/
.scratch/reviews/
.scratch/arbitrations/
EXCL
}

_snapshot_agents() {
    # ── Snapshot staged agents into container-local directory ────────────────
    # /staged-agents is the host launcher's compile output — a warm cache only.
    # Eager validation of AGENT_TYPE happens elsewhere:
    #   * FSM mode  → _prefetch_role_agents fetches every role agent from the
    #                 server, populating both .md and .meta.json sidecars.
    #   * non-FSM   → AGENT_TYPE is the sole agent; _ensure_agent_type below
    #                 fetches it if the staged copy is missing.
    mkdir -p "$AGENTS_DIR"
    if [ -d /staged-agents ] && ls /staged-agents/*.md &>/dev/null; then
        cp /staged-agents/* "$AGENTS_DIR/"
        echo "── Agent definitions snapshotted ──"
        ls -1 "$AGENTS_DIR"/*.md 2>/dev/null | while read -r f; do echo "  $(basename "$f")"; done
    else
        echo "Note: no pre-staged agent definitions in /staged-agents (will fetch from server)."
    fi

    if ! _is_fsm_mode; then
        # Non-FSM mode: AGENT_TYPE is the sole agent for this container.
        if [ ! -f "$AGENTS_DIR/${AGENT_TYPE}.md" ]; then
            echo "Agent type '${AGENT_TYPE}' not in snapshot — fetching from server..."
            if ! _ensure_agent_type "$AGENT_TYPE"; then
                echo "ERROR: Agent type '${AGENT_TYPE}' not in snapshot and server fetch failed." >&2
                exit 1
            fi
        fi
        echo "Verified: ${AGENT_TYPE}.md is present."
    fi
    echo ""
}

# Container-side FSM role-agent set. Populated by _prefetch_role_agents and
# consumed by _setup_hooks. Space-separated list of agent names. Empty when
# the container is not in FSM mode or the project has no agentRoles configured.
FSM_ROLE_AGENTS=""

_prefetch_role_agents() {
    # In FSM mode, the daisy-chain dispatches engineer + arbitrator + every
    # reviewer per task. Fetch each role's compiled markdown and meta sidecar
    # up front so:
    #   1. _setup_hooks can compute the union access-scope across the role set
    #      to derive container-level hook flags correctly.
    #   2. _run_claude's per-role invocations hit cache instead of a per-cycle
    #      server round-trip.
    if ! _is_fsm_mode; then
        return 0
    fi

    echo "── Prefetching FSM role agents ──"

    local config_resp
    config_resp=$(_curl_server -sf "${SERVER_URL}/config/${PROJECT_ID}" --max-time 15 2>/dev/null) || config_resp=""
    if [ -z "$config_resp" ]; then
        echo "WARNING: Could not fetch /config/${PROJECT_ID}; FSM container will rely on per-task role lookup." >&2
        return 0
    fi

    local roles_json
    roles_json=$(printf '%s' "$config_resp" | jq -c '.agentRoles // {}' 2>/dev/null) || roles_json="{}"
    if [ "$roles_json" = "{}" ] || [ -z "$roles_json" ]; then
        echo "WARNING: project '${PROJECT_ID}' has no agentRoles in scaffold.config.json — container hook profile defaults to read-only." >&2
        return 0
    fi

    local role_list
    role_list=$(printf '%s' "$roles_json" | jq -r '
        [.engineer // empty, .arbitrator // empty]
        + ((.reviewers // {}) | to_entries | map(.value))
        | map(select(. != null and . != ""))
        | unique
        | join(" ")
    ' 2>/dev/null) || role_list=""

    if [ -z "$role_list" ]; then
        echo "WARNING: agentRoles for project '${PROJECT_ID}' is empty after extraction." >&2
        return 0
    fi

    FSM_ROLE_AGENTS="$role_list"
    echo "Role agents to prefetch: ${FSM_ROLE_AGENTS}"

    local role
    for role in $FSM_ROLE_AGENTS; do
        if ! _ensure_agent_type "$role"; then
            echo "ERROR: Failed to fetch FSM role agent '${role}' from server." >&2
            exit 1
        fi
    done
    echo ""
}

# Rank an access-scope string; higher number = broader access.
# read-only(0) < write-access(1) < ubt-build-hook-interceptor(2).
# Unknown values return 1 (write-access) — same defensive default the inline
# case below applies before this refactor.
_access_scope_rank() {
    case "$1" in
        read-only)                  echo 0 ;;
        write-access)               echo 1 ;;
        ubt-build-hook-interceptor) echo 2 ;;
        *)                          echo 1 ;;
    esac
}

_access_scope_for_rank() {
    case "$1" in
        0) echo "read-only" ;;
        1) echo "write-access" ;;
        2) echo "ubt-build-hook-interceptor" ;;
        *) echo "write-access" ;;
    esac
}

# Echo the union access-scope across every agent in FSM_ROLE_AGENTS by reading
# each cached .meta.json sidecar and taking the highest rank. Falls back to
# "read-only" when FSM_ROLE_AGENTS is empty (no roles configured).
_union_access_scope_for_fsm_roles() {
    local highest_rank=0
    local role meta scope rank
    for role in $FSM_ROLE_AGENTS; do
        meta="${AGENTS_DIR}/${role}.meta.json"
        if [ ! -f "$meta" ]; then
            echo "WARNING: missing meta sidecar for role agent '${role}'; treating as read-only" >&2
            continue
        fi
        scope=$(jq -r '.["access-scope"] // "read-only"' "$meta")
        rank=$(_access_scope_rank "$scope")
        if [ "$rank" -gt "$highest_rank" ]; then
            highest_rank="$rank"
        fi
    done
    _access_scope_for_rank "$highest_rank"
}

_setup_hooks() {
    # ── Resolve the access-scope that drives container hook flags ────────────
    # FSM mode: the container will dispatch every role in agentRoles, so the
    # hook profile must satisfy the broadest role. Compute the union scope
    # across every prefetched role agent's meta sidecar.
    # Non-FSM mode: AGENT_TYPE is the sole agent; read its meta sidecar.
    local ACCESS_SCOPE="read-only"
    if _is_fsm_mode; then
        ACCESS_SCOPE=$(_union_access_scope_for_fsm_roles)
        echo "FSM role set: ${FSM_ROLE_AGENTS:-<none>}"
        echo "Union access-scope: ${ACCESS_SCOPE}"
    else
        local META_FILE="${AGENTS_DIR}/${AGENT_TYPE}.meta.json"
        if [ -f "$META_FILE" ]; then
            ACCESS_SCOPE=$(jq -r '.["access-scope"] // "read-only"' "$META_FILE")
        fi
    fi

    # ── Derive hook flags from access scope ─────────────────────────────────
    case "$ACCESS_SCOPE" in
        read-only)
            HOOK_BUILD_INTERCEPT="false"
            HOOK_GIT_SYNC="false"
            WORKSPACE_READONLY="true"
            ;;
        write-access)
            HOOK_BUILD_INTERCEPT="false"
            HOOK_GIT_SYNC="true"
            WORKSPACE_READONLY="false"
            ;;
        ubt-build-hook-interceptor)
            HOOK_BUILD_INTERCEPT="true"
            HOOK_GIT_SYNC="false"
            WORKSPACE_READONLY="false"
            ;;
        *)
            HOOK_BUILD_INTERCEPT="false"
            HOOK_GIT_SYNC="true"
            WORKSPACE_READONLY="false"
            echo "WARNING: Unknown access-scope '$ACCESS_SCOPE', treating as write-access" >&2
            ;;
    esac

    # CLI override escape hatch (--hooks / --no-hooks via launch.sh)
    if [ "${HOOK_OVERRIDE:-}" = "all-on" ]; then
        HOOK_BUILD_INTERCEPT="true"
        HOOK_GIT_SYNC="false"
    elif [ "${HOOK_OVERRIDE:-}" = "all-off" ]; then
        HOOK_BUILD_INTERCEPT="false"
        HOOK_GIT_SYNC="false"
    fi

    # C++ lint is orthogonal to access scope
    HOOK_CPP_LINT="${HOOK_CPP_LINT:-false}"
    case "${HOOK_CPP_LINT}" in
      true|false) ;;
      *) echo "ERROR: HOOK_CPP_LINT must be 'true' or 'false', got '${HOOK_CPP_LINT}'" >&2; exit 1 ;;
    esac

    # JS/TS lint+format is orthogonal to access scope
    HOOK_JS_LINT="${HOOK_JS_LINT:-false}"
    case "${HOOK_JS_LINT}" in
      true|false) ;;
      *) echo "ERROR: HOOK_JS_LINT must be 'true' or 'false', got '${HOOK_JS_LINT}'" >&2; exit 1 ;;
    esac

    echo "Access scope: ${ACCESS_SCOPE} (buildIntercept=${HOOK_BUILD_INTERCEPT}, gitSync=${HOOK_GIT_SYNC}, readonly=${WORKSPACE_READONLY})"

    # Build the PreToolUse Bash matcher hooks array
    local PRE_BASH PRE_MATCHERS POST_MATCHERS
    PRE_BASH=$(jq -n '[{"type":"command","command":"bash /claude-hooks/inject-agent-header.sh"}]')
    if [ "${HOOK_BUILD_INTERCEPT}" = "true" ]; then
        PRE_BASH=$(jq -n --argjson base "$PRE_BASH" \
            '[{"type":"command","command":"bash /claude-hooks/intercept_build_test.sh"},{"type":"command","command":"bash /claude-hooks/block-push-passthrough.sh"}] + $base')
    fi
    if [ "${WORKSPACE_READONLY}" = "false" ]; then
        PRE_BASH=$(jq -n --argjson base "$PRE_BASH" \
            '[{"type":"command","command":"bash /claude-hooks/guard-branch.sh"}] + $base')
    fi

    PRE_MATCHERS=$(jq -n --argjson hooks "$PRE_BASH" '[{"matcher":"Bash","hooks":$hooks}]')

    if [ "${HOOK_CPP_LINT}" = "true" ]; then
        PRE_MATCHERS=$(jq -n --argjson m "$PRE_MATCHERS" \
            '$m + [{"matcher":"Edit","hooks":[{"type":"command","command":"node /claude-hooks/lint-cpp-diff.mjs"}]},{"matcher":"Write","hooks":[{"type":"command","command":"node /claude-hooks/lint-cpp-diff.mjs"}]}]')
    fi

    POST_MATCHERS="[]"
    if [ "${HOOK_JS_LINT}" = "true" ]; then
        POST_MATCHERS=$(jq -n --argjson m "$POST_MATCHERS" \
            '$m + [{"matcher":"Edit","hooks":[{"type":"command","command":"bash /claude-hooks/lint-format.sh"}]},{"matcher":"Write","hooks":[{"type":"command","command":"bash /claude-hooks/lint-format.sh"}]}]')
    fi
    if [ "${HOOK_GIT_SYNC}" = "true" ]; then
        POST_MATCHERS=$(jq -n --argjson m "$POST_MATCHERS" \
            '$m + [{"matcher":"Bash","hooks":[{"type":"command","command":"bash /claude-hooks/push-after-commit.sh"}]}]')
    fi

    # Write the final settings file
    jq -n --argjson pre "$PRE_MATCHERS" --argjson post "$POST_MATCHERS" \
        'if ($post | length) > 0 then {"hooks":{"PreToolUse":$pre,"PostToolUse":$post}} else {"hooks":{"PreToolUse":$pre}} end' \
        > /home/claude/.claude/settings.json

    echo "Hook settings: buildIntercept=${HOOK_BUILD_INTERCEPT}, cppLint=${HOOK_CPP_LINT}, jsLint=${HOOK_JS_LINT}, gitSync=${HOOK_GIT_SYNC}"
    echo ""
    echo "── Resolved hook settings.json ──"
    cat /home/claude/.claude/settings.json
    echo ""
}

_symlink_plugins() {
    # ── Symlink read-only plugin mounts ─────────────────────────────────────
    if [ -d /plugins-ro ]; then
        mkdir -p /workspace/Plugins
        for plugin_dir in /plugins-ro/*/; do
            [ -d "$plugin_dir" ] || continue
            plugin_name="$(basename "$plugin_dir")"
            # Reject traversal names
            if [[ -z "$plugin_name" || "$plugin_name" == "." || "$plugin_name" == ".." ]]; then
                echo "WARNING: skipping suspicious plugin directory name: '$plugin_dir'" >&2
                continue
            fi
            link="/workspace/Plugins/$plugin_name"
            if [ ! -e "$link" ]; then
                ln -sfn "$plugin_dir" "$link"
                echo "Symlinked $plugin_dir -> $link"
            fi
        done
    fi
}

