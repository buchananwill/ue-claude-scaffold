#!/bin/bash
# Claude Code PreToolUse hook for the Docker container.
#
# Intercepts bash commands that invoke the project's build or test scripts.
# Instead of running them locally (no UE install in container), this hook:
#   1. Commits and pushes current changes to the bare repo
#   2. Acquires the UBT lock (waiting in queue if necessary)
#   3. Calls the host coordination server
#   4. Releases the UBT lock
#   5. Prints the structured output (which Claude Code sees as the command result)
#   6. Exits with code 2 to block the original command
#
# Non-build/test commands pass through unchanged (exit 0).

set -euo pipefail

SERVER_URL="${SERVER_URL:-http://host.docker.internal:9100}"
WORK_BRANCH="${WORK_BRANCH:-main}"
AGENT_NAME="${AGENT_NAME:-agent-1}"

# Build/test script names — configurable via env vars
BUILD_SCRIPT_NAME="${BUILD_SCRIPT_NAME:-build.py}"
TEST_SCRIPT_NAME="${TEST_SCRIPT_NAME:-run_tests.py}"

LOCK_HELD=false
QUEUED_MSG_POSTED=false

cleanup() {
    if [ "$LOCK_HELD" = "true" ]; then
        local tmp
        tmp=$(mktemp)
        jq -n --arg agent "$AGENT_NAME" '{"agent": $agent}' > "$tmp"
        curl -s -X POST "${SERVER_URL}/ubt/release" \
            -H "Content-Type: application/json" \
            -d "@$tmp" \
            --max-time 5 >/dev/null 2>&1 || true
        rm -f "$tmp"
    fi
}
trap cleanup EXIT

post_message() {
    local msg_type="$1"
    local payload="$2"
    local tmp
    tmp=$(mktemp)
    jq -n --arg channel "$AGENT_NAME" --arg type "$msg_type" --argjson payload "$payload" \
        '{"channel": $channel, "type": $type, "payload": $payload}' > "$tmp"
    curl -s -X POST "${SERVER_URL}/messages" \
        -H "Content-Type: application/json" \
        -H "X-Agent-Name: ${AGENT_NAME}" \
        -d "@$tmp" \
        --max-time 5 >/dev/null 2>&1 || true
    rm -f "$tmp"
}

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

# ── Determine operation and request body ─────────────────────────────────────

if echo "$COMMAND" | grep -qE "${TEST_SCRIPT_NAME}"; then
    OPERATION="test"
    # Extract test filters from the command
    FILTERS=$(echo "$COMMAND" | sed -E "s/.*${TEST_SCRIPT_NAME}\s*//" | tr ' ' '\n' | grep -v '^--' | tr '\n' ' ' | xargs)

    if [ -z "$FILTERS" ]; then
        FILTERS="${DEFAULT_TEST_FILTERS:-}"
    fi

    # Build JSON payload
    if [ -z "$FILTERS" ]; then
        REQUEST_BODY='{"filters": []}'
    else
        REQUEST_BODY=$(echo "$FILTERS" | tr ' ' '\n' | jq -R . | jq -s '{ filters: . }')
    fi
else
    OPERATION="build"
    CLEAN_FLAG="false"
    if echo "$COMMAND" | grep -q '\-\-clean'; then
        CLEAN_FLAG="true"
    fi
    REQUEST_BODY=$(jq -n --argjson clean "$CLEAN_FLAG" '{"clean": $clean}')
fi

# ── Acquire UBT lock ────────────────────────────────────────────────────────

echo "Acquiring UBT lock..."
while true; do
    ACQ_TMP=$(mktemp)
    jq -n --arg agent "$AGENT_NAME" '{"agent": $agent}' > "$ACQ_TMP"
    ACQ_RESPONSE=$(curl -s -X POST "${SERVER_URL}/ubt/acquire" \
        -H "Content-Type: application/json" \
        -d "@$ACQ_TMP" \
        --max-time 10) || ACQ_RESPONSE=""
    rm -f "$ACQ_TMP"

    GRANTED=$(echo "$ACQ_RESPONSE" | jq -r '.granted // empty' 2>/dev/null || echo "")

    if [ "$GRANTED" = "true" ]; then
        LOCK_HELD=true
        echo "UBT lock acquired."
        break
    fi

    # Handle network errors or malformed responses
    if [ -z "$GRANTED" ] || [ "$GRANTED" = "null" ]; then
        echo "Warning: Could not reach coordination server for lock. Retrying in 5s..."
        sleep 5
        continue
    fi

    POSITION=$(echo "$ACQ_RESPONSE" | jq -r '.position // 1')
    BACKOFF_MS=$(echo "$ACQ_RESPONSE" | jq -r '.backoffMs // 5000')
    HOLDER=$(echo "$ACQ_RESPONSE" | jq -r '.holder // "unknown"')
    HOLDER_SINCE=$(echo "$ACQ_RESPONSE" | jq -r '.holderSince // "unknown"')
    EST_WAIT_MS=$(echo "$ACQ_RESPONSE" | jq -r '.estimatedWaitMs // 0')
    EST_WAIT_MIN=$(( EST_WAIT_MS / 60000 ))

    if [ "$QUEUED_MSG_POSTED" = "false" ]; then
        QUEUED_PAYLOAD=$(jq -n --arg holder "$HOLDER" --argjson position "$POSITION" --argjson wait "$EST_WAIT_MS" \
            '{"holder": $holder, "position": $position, "estimatedWaitMs": $wait}')
        post_message "build_queued" "$QUEUED_PAYLOAD"
        QUEUED_MSG_POSTED=true
    fi

    echo "Build queued — UBT held by ${HOLDER} since ${HOLDER_SINCE} (position ${POSITION}, est. wait ~${EST_WAIT_MIN} min). Waiting..."

    BACKOFF_S=$(( BACKOFF_MS / 1000 ))
    [ "$BACKOFF_S" -lt 1 ] && BACKOFF_S=5
    sleep "$BACKOFF_S"
done

# ── Post start message ───────────────────────────────────────────────────────

START_PAYLOAD=$(jq -n --arg op "$OPERATION" '{"operation": $op}')
if [ "$OPERATION" = "build" ]; then
    post_message "build_start" "$START_PAYLOAD"
else
    post_message "test_start" "$START_PAYLOAD"
fi

# ── Call the coordination server ─────────────────────────────────────────────

if [ "$OPERATION" = "test" ]; then
    CURL_TIMEOUT=820
else
    CURL_TIMEOUT=780
fi

RESPONSE=$(curl -s -X POST "${SERVER_URL}/${OPERATION}" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Name: ${AGENT_NAME}" \
    -d "$REQUEST_BODY" \
    --max-time $CURL_TIMEOUT)

# ── Release lock immediately ─────────────────────────────────────────────────

REL_TMP=$(mktemp)
jq -n --arg agent "$AGENT_NAME" '{"agent": $agent}' > "$REL_TMP"
curl -s -X POST "${SERVER_URL}/ubt/release" \
    -H "Content-Type: application/json" \
    -d "@$REL_TMP" \
    --max-time 5 >/dev/null 2>&1 || true
rm -f "$REL_TMP"
LOCK_HELD=false

# ── Post completion message ──────────────────────────────────────────────────

SUCCESS=$(echo "$RESPONSE" | jq -r '.success // false')
END_PAYLOAD=$(jq -n --arg op "$OPERATION" --argjson success "$SUCCESS" '{"operation": $op, "success": $success}')
if [ "$OPERATION" = "build" ]; then
    post_message "build_end" "$END_PAYLOAD"
else
    post_message "test_end" "$END_PAYLOAD"
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
