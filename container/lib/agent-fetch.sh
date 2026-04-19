#!/bin/bash
# container/lib/agent-fetch.sh — Fetch and cache agent definitions from the server.
# Sourced by entrypoint.sh; do not execute directly.

_ensure_agent_type() {
    # Ensure that the agent definition for <agent_type> is available locally.
    # Checks if /home/claude/.claude/agents/<agent_type>.md exists.
    # If not, fetches from GET /agents/definitions/<agent_type> and writes:
    #   /home/claude/.claude/agents/<agent_type>.md
    #   /home/claude/.claude/agents/<agent_type>.meta.json
    # Returns 0 on success, 1 on failure.
    local agent_type="$1"

    if [ -z "$agent_type" ]; then
        echo "ERROR: _ensure_agent_type called with empty agent_type" >&2
        return 1
    fi

    local agent_file="${AGENTS_DIR}/${agent_type}.md"
    local meta_file="${AGENTS_DIR}/${agent_type}.meta.json"

    # Already cached — nothing to do
    if [ -f "$agent_file" ]; then
        echo "Agent definition '${agent_type}' already cached."
        return 0
    fi

    echo "Fetching agent definition '${agent_type}' from server..."

    local response http_status body
    response=$(_curl_server -s -w "\n%{http_code}" \
        "${SERVER_URL}/agents/definitions/${agent_type}" \
        --max-time 15) || response=$'\n000'
    http_status="${response##*$'\n'}"
    body="${response%$'\n'*}"

    if [ "$http_status" != "200" ]; then
        echo "ERROR: Failed to fetch agent definition '${agent_type}' (HTTP ${http_status})" >&2
        return 1
    fi

    # Extract the compiled markdown and metadata from the response
    local compiled_md access_scope
    compiled_md=$(echo "$body" | jq -r '.compiled // empty')
    if [ -z "$compiled_md" ]; then
        echo "ERROR: Server returned empty compiled definition for '${agent_type}'" >&2
        return 1
    fi

    # Write the agent definition
    mkdir -p "$AGENTS_DIR"
    echo "$compiled_md" > "$agent_file"

    # Write the meta.json sidecar (extract access-scope from response metadata)
    access_scope=$(echo "$body" | jq -r '.metadata["access-scope"] // "read-only"')
    jq -n --arg scope "$access_scope" '{"access-scope": $scope}' > "$meta_file"

    echo "Cached agent definition '${agent_type}' (access-scope: ${access_scope})"
    return 0
}
