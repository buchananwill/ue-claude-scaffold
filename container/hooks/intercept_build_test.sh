#!/bin/bash
# Claude Code PreToolUse hook for the Docker container.
#
# Intercepts bash commands that invoke the project's build or test scripts.
# Instead of running them locally (no UE install in container), this hook:
#   1. Commits and pushes current changes to the bare repo
#   2. Calls the host coordination server
#   3. Prints the structured output (which Claude Code sees as the command result)
#   4. Exits with code 2 to block the original command
#
# Non-build/test commands pass through unchanged (exit 0).

set -euo pipefail

SERVER_URL="${SERVER_URL:-http://host.docker.internal:9100}"
WORK_BRANCH="${WORK_BRANCH:-main}"
AGENT_NAME="${AGENT_NAME:-agent-1}"

# Build/test script names — configurable via env vars
BUILD_SCRIPT_NAME="${BUILD_SCRIPT_NAME:-build.py}"
TEST_SCRIPT_NAME="${TEST_SCRIPT_NAME:-run_tests.py}"

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# ── Pass through non-build/test commands ─────────────────────────────────────

if ! echo "$COMMAND" | grep -qE "(${BUILD_SCRIPT_NAME}|${TEST_SCRIPT_NAME})"; then
    exit 0
fi

# ── Commit and push current state to bare repo ──────────────────────────────

cd "$CLAUDE_PROJECT_DIR"

git add -A

if ! git diff --cached --quiet; then
    git commit -m "Container auto-commit for build/test" --no-gpg-sign
fi

git push origin "HEAD:${WORK_BRANCH}" --force

# ── Route to host coordination server ────────────────────────────────────────

if echo "$COMMAND" | grep -qE "${TEST_SCRIPT_NAME}"; then
    # Extract test filters from the command
    FILTERS=$(echo "$COMMAND" | sed -E "s/.*${TEST_SCRIPT_NAME}\s*//" | tr ' ' '\n' | grep -v '^--' | tr '\n' ' ' | xargs)

    if [ -z "$FILTERS" ]; then
        FILTERS="${DEFAULT_TEST_FILTERS:-}"
    fi

    # Build JSON payload
    FILTER_JSON=$(echo "$FILTERS" | tr ' ' '\n' | jq -R . | jq -s '{ filters: . }')

    RESPONSE=$(curl -s -X POST "${SERVER_URL}/test" \
        -H "Content-Type: application/json" \
        -H "X-Agent-Name: ${AGENT_NAME}" \
        -d "$FILTER_JSON" \
        --max-time 700)

else
    # Build request
    CLEAN_FLAG="false"
    if echo "$COMMAND" | grep -q '\-\-clean'; then
        CLEAN_FLAG="true"
    fi

    RESPONSE=$(curl -s -X POST "${SERVER_URL}/build" \
        -H "Content-Type: application/json" \
        -H "X-Agent-Name: ${AGENT_NAME}" \
        -d "{\"clean\": ${CLEAN_FLAG}}" \
        --max-time 620)
fi

# ── Extract and print the output ─────────────────────────────────────────────

OUTPUT=$(echo "$RESPONSE" | jq -r '.output // "No output received from coordination server"')
STDERR=$(echo "$RESPONSE" | jq -r '.stderr // empty')

echo "$OUTPUT"
if [ -n "$STDERR" ]; then
    echo "$STDERR" >&2
fi

# Exit 2 blocks the original command and sends our output as feedback to Claude
exit 2
