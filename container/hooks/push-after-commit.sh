#!/bin/bash
# PostToolUse hook: after a successful git commit, automatically pushes
# the current branch to the bare repo on the host.
#
# This ensures every commit is persisted outside the ephemeral container.
# The push targets the agent's assigned branch (WORK_BRANCH) on origin.

set -euo pipefail

WORK_BRANCH="${WORK_BRANCH:-main}"
AGENT_NAME="${AGENT_NAME:-agent-1}"
SERVER_URL="${SERVER_URL:-http://host.docker.internal:9100}"
PROJECT_ID="${PROJECT_ID:-default}"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_result.exit_code // .exit_code // "0"')

# Only act on successful git commit commands
if [ "$EXIT_CODE" != "0" ]; then
    exit 0
fi

if ! echo "$COMMAND" | grep -qE 'git\s+commit\s'; then
    exit 0
fi

# Verify we're on the correct branch before pushing
CURRENT=$(git symbolic-ref --short HEAD 2>/dev/null || echo "DETACHED")
EXPECTED=$(echo "$WORK_BRANCH" | sed 's|^origin/||')

if [ "$CURRENT" != "$EXPECTED" ] && [ "$CURRENT" != "$WORK_BRANCH" ]; then
    echo "Warning: HEAD is on '$CURRENT', not '$WORK_BRANCH'. Push skipped." >&2
    echo "Only commits on your assigned branch are persisted." >&2
    exit 0
fi

# Push to bare repo
if git push origin "HEAD:${WORK_BRANCH}" --force 2>&1; then
    echo "Pushed to bare repo: ${WORK_BRANCH}" >&2
else
    echo "ERROR: Failed to push to bare repo. Work may not be persisted externally." >&2
    # Notify coordination server of push failure
    PAYLOAD=$(jq -n --arg agent "$AGENT_NAME" --arg branch "$WORK_BRANCH" \
        '{"agent": $agent, "branch": $branch, "error": "push failed"}')
    curl -s -X POST "${SERVER_URL}/messages" \
        -H "Content-Type: application/json" \
        -H "X-Agent-Name: ${AGENT_NAME}" \
        -H "X-Project-Id: ${PROJECT_ID}" \
        -d "$(jq -n --arg channel "$AGENT_NAME" --argjson payload "$PAYLOAD" \
            '{"channel": $channel, "type": "push_failed", "payload": $payload}')" \
        --max-time 5 >/dev/null 2>&1 || true
fi

exit 0
