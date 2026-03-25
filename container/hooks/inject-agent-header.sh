#!/bin/bash
# PreToolUse hook: injects X-Agent-Name header into curl commands that
# target the coordination server's message or room endpoints.
#
# If the command already contains X-Agent-Name, it passes through unchanged.
# Otherwise, the hook re-executes the curl with the header injected and
# exits 2 to block the original (headerless) command.

set -euo pipefail

SERVER_URL="${SERVER_URL:-http://host.docker.internal:9100}"
AGENT_NAME="${AGENT_NAME:-agent-1}"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only act on curl commands
if ! echo "$COMMAND" | grep -qE '^\s*curl\s'; then
    exit 0
fi

# Only act on requests to the coordination server
if ! echo "$COMMAND" | grep -qF "$SERVER_URL"; then
    exit 0
fi

# Only act on message/room endpoints
if ! echo "$COMMAND" | grep -qE '(/messages|/rooms/)'; then
    exit 0
fi

# If the header is already present, pass through
if echo "$COMMAND" | grep -qF 'X-Agent-Name'; then
    exit 0
fi

# Re-execute the curl command with identity headers injected.
# Insert the headers right after 'curl'.
AUTH_HEADERS="-H \"X-Agent-Name: ${AGENT_NAME}\""
if [ -n "${SESSION_TOKEN:-}" ]; then
    AUTH_HEADERS="${AUTH_HEADERS} -H \"Authorization: Bearer ${SESSION_TOKEN}\""
fi
MODIFIED=$(echo "$COMMAND" | sed "s|curl |curl ${AUTH_HEADERS} |")

echo "Injecting identity headers for agent: ${AGENT_NAME}" >&2
eval "$MODIFIED"
exit 2
