#!/bin/bash
# container/lib/agent-fetch.sh — Fetch and cache agent definitions from the server.
# Sourced by entrypoint.sh; do not execute directly.

# Maximum size of a single compiled agent definition we'll accept from the server.
# Same guard for the lead and any bundled sub-agent.
_AGENT_DEFINITION_MAX_BYTES=524288

# Write one compiled agent (markdown + meta.json sidecar) to AGENTS_DIR.
# Returns 0 on success, 1 on failure (size guard, missing markdown).
_write_agent_definition() {
    local agent_type="$1"
    local compiled_md="$2"
    local access_scope="$3"

    if [ -z "$compiled_md" ]; then
        echo "ERROR: Empty compiled definition for '${agent_type}'" >&2
        return 1
    fi

    local compiled_size
    compiled_size=$(printf '%s\n' "$compiled_md" | wc -c)
    if [ "$compiled_size" -gt "$_AGENT_DEFINITION_MAX_BYTES" ]; then
        echo "ERROR: Agent definition '${agent_type}' exceeds 512KB (${compiled_size} bytes)" >&2
        return 1
    fi

    mkdir -p "$AGENTS_DIR"
    printf '%s\n' "$compiled_md" > "${AGENTS_DIR}/${agent_type}.md"
    jq -n --arg scope "$access_scope" '{"access-scope": $scope}' \
        > "${AGENTS_DIR}/${agent_type}.meta.json"
    echo "Cached agent definition '${agent_type}' (access-scope: ${access_scope})"
    return 0
}

_ensure_agent_type() {
    # Ensure that the agent definition for <agent_type> is available locally,
    # along with every sub-agent the lead's compiled body references.
    #
    # Checks if /home/claude/.claude/agents/<agent_type>.md exists; if not,
    # fetches from GET /agents/definitions/<agent_type> and writes the lead
    # plus every entry in the response's `subAgents` bundle to AGENTS_DIR.
    # Already-cached sub-agents are skipped to avoid clobbering newer copies.
    # Returns 0 on success, 1 on failure.
    local agent_type="$1"

    if [ -z "$agent_type" ]; then
        echo "ERROR: _ensure_agent_type called with empty agent_type" >&2
        return 1
    fi

    if ! _is_safe_name "$agent_type"; then
        echo "ERROR: agent_type contains invalid characters: $agent_type" >&2
        return 1
    fi

    local lead_file="${AGENTS_DIR}/${agent_type}.md"
    if [ -f "$lead_file" ]; then
        echo "Agent definition '${agent_type}' already cached."
        return 0
    fi

    echo "Fetching agent definition '${agent_type}' from server..."

    local response http_status body
    response=$(_curl_server -s -w "\n%{http_code}" --max-time 15 \
        "${SERVER_URL}/agents/definitions/${agent_type}") || response=$'\n000'
    http_status="${response##*$'\n'}"
    body="${response%$'\n'*}"

    if [ "$http_status" != "200" ]; then
        # Surface the server's error body so the operator can see whether this
        # was a 404 (missing definition), 500 (compile error), etc., without
        # having to attach to the container logs.
        local body_excerpt
        body_excerpt=$(printf '%s' "$body" | head -c 500)
        echo "ERROR: Failed to fetch agent definition '${agent_type}' (HTTP ${http_status}): ${body_excerpt}" >&2
        return 1
    fi

    # Lead agent
    local lead_md lead_scope
    lead_md=$(printf '%s' "$body" | jq -r '.markdown // empty')
    lead_scope=$(printf '%s' "$body" | jq -r '.meta["access-scope"] // "read-only"')
    if ! _write_agent_definition "$agent_type" "$lead_md" "$lead_scope"; then
        return 1
    fi

    # Sub-agents bundled in the same response. Each sub is { agentType, markdown, meta }.
    # Iterate via jq's @base64 encoding so embedded newlines survive shell parsing.
    local sub_count
    sub_count=$(printf '%s' "$body" | jq -r '(.subAgents // []) | length')
    if [ "$sub_count" != "0" ] && [ -n "$sub_count" ]; then
        local i sub_type sub_md sub_scope sub_path
        for ((i = 0; i < sub_count; i++)); do
            sub_type=$(printf '%s' "$body" | jq -r ".subAgents[$i].agentType")
            if ! _is_safe_name "$sub_type"; then
                echo "WARNING: skipping sub-agent with invalid name: $sub_type" >&2
                continue
            fi
            sub_path="${AGENTS_DIR}/${sub_type}.md"
            if [ -f "$sub_path" ]; then
                echo "Sub-agent '${sub_type}' already cached — leaving in place."
                continue
            fi
            sub_md=$(printf '%s' "$body" | jq -r ".subAgents[$i].markdown // empty")
            sub_scope=$(printf '%s' "$body" | jq -r ".subAgents[$i].meta[\"access-scope\"] // \"read-only\"")
            if ! _write_agent_definition "$sub_type" "$sub_md" "$sub_scope"; then
                echo "WARNING: failed to write bundled sub-agent '${sub_type}'" >&2
            fi
        done
    fi

    # Surface server-side warnings (e.g. two-level nesting attempts) on stderr.
    local warn_count
    warn_count=$(printf '%s' "$body" | jq -r '(.warnings // []) | length')
    if [ "$warn_count" != "0" ] && [ -n "$warn_count" ]; then
        local j warn_msg
        for ((j = 0; j < warn_count; j++)); do
            warn_msg=$(printf '%s' "$body" | jq -r ".warnings[$j]")
            echo "WARNING (server): ${warn_msg}" >&2
        done
    fi

    return 0
}
