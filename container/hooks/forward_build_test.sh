#!/bin/bash
# Build/test transport for the Docker container.
#
# Invoked by the project's build/test scripts (Scripts/build.py, Scripts/run_tests.py)
# when they detect they are running inside a scaffold container (via the
# SCAFFOLD_FORWARD_SCRIPT env var). This script is dumb transport: it does NOT parse or
# interpret the request beyond reading ".operation" to choose the endpoint. The Python
# script already authored the structured payload; this script only:
#   1. Commits and pushes the current working tree to the bare repo
#   2. Acquires the UBT lock (queueing if necessary)
#   3. POSTs the payload verbatim to the host coordination server
#   4. Releases the UBT lock
#   5. Prints the server's structured output (stdout) and stderr
#   6. Exits 0 on success, 1 on failure
#
# Usage: forward_build_test.sh <payload.json>
#   <payload.json> must contain {"operation": "build"|"test", ...}.

set -euo pipefail

SERVER_URL="${SERVER_URL:-http://host.docker.internal:9100}"
WORK_BRANCH="${WORK_BRANCH:-main}"
AGENT_NAME="${AGENT_NAME:-agent-1}"
AGENT_ID="${AGENT_ID:-}"
PROJECT_ID="${PROJECT_ID:-default}"

PAYLOAD_FILE="${1:-}"
if [ -z "$PAYLOAD_FILE" ] || [ ! -f "$PAYLOAD_FILE" ]; then
    echo "forward_build_test.sh: missing or unreadable payload file argument" >&2
    exit 2
fi

OPERATION=$(jq -r '.operation // empty' "$PAYLOAD_FILE")
if [ "$OPERATION" != "build" ] && [ "$OPERATION" != "test" ]; then
    echo "forward_build_test.sh: payload .operation must be 'build' or 'test' (got '${OPERATION}')" >&2
    exit 2
fi

LOCK_HELD=false
QUEUED_MSG_POSTED=false

cleanup() {
    if [ "$LOCK_HELD" = "true" ]; then
        local tmp
        tmp=$(mktemp)
        jq -n --arg agent "$AGENT_NAME" '{"agent": $agent}' > "$tmp"
        curl -s -X POST "${SERVER_URL}/ubt/release" \
            -H "Content-Type: application/json" \
            -H "X-Agent-Name: ${AGENT_NAME}" \
            -H "X-Project-Id: ${PROJECT_ID}" \
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
        -H "X-Project-Id: ${PROJECT_ID}" \
        -d "@$tmp" \
        --max-time 5 >/dev/null 2>&1 || true
    rm -f "$tmp"
}

# ── Commit and push current state to bare repo ──────────────────────────────

# Unlike the old PreToolUse hook, this transport runs as a subprocess of build.py /
# run_tests.py, so CLAUDE_PROJECT_DIR is not guaranteed to be set. Under `set -u` a bare
# "$CLAUDE_PROJECT_DIR" would abort with "unbound variable". Fall back to the inherited
# cwd, which is the workspace root (build.py is invoked from there).
cd "${CLAUDE_PROJECT_DIR:-$PWD}"

git add -A

if ! git diff --cached --quiet; then
    git commit -m "Container auto-commit for build/test" --no-gpg-sign
fi

git push origin "HEAD:${WORK_BRANCH}" --force

# ── Acquire UBT lock ────────────────────────────────────────────────────────

echo "Acquiring UBT lock..."
while true; do
    ACQ_TMP=$(mktemp)
    jq -n --arg agent "$AGENT_NAME" '{"agent": $agent}' > "$ACQ_TMP"
    ACQ_RESPONSE=$(curl -s -X POST "${SERVER_URL}/ubt/acquire" \
        -H "Content-Type: application/json" \
        -H "X-Agent-Name: ${AGENT_NAME}" \
        -H "X-Project-Id: ${PROJECT_ID}" \
        -d "@$ACQ_TMP" \
        --max-time 10) || ACQ_RESPONSE=""
    rm -f "$ACQ_TMP"

    GRANTED=$(echo "$ACQ_RESPONSE" | jq -r '.granted // empty' 2>/dev/null || echo "")

    if [ "$GRANTED" = "true" ]; then
        LOCK_HELD=true
        echo "UBT lock acquired."
        break
    fi

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

# Must exceed the server's build/test ceiling (8h) plus margin, or the container would
# abandon a long-but-healthy build while the host keeps compiling. The server owns the
# real kill timer; this curl just has to outlast it.
if [ "$OPERATION" = "test" ]; then
    CURL_TIMEOUT=29400
else
    CURL_TIMEOUT=29200
fi

RESPONSE=$(curl -s -X POST "${SERVER_URL}/${OPERATION}" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Name: ${AGENT_NAME}" \
    -H "X-Agent-Id: ${AGENT_ID}" \
    -H "X-Project-Id: ${PROJECT_ID}" \
    --data-binary @"$PAYLOAD_FILE" \
    --max-time $CURL_TIMEOUT)

# ── Release lock immediately ─────────────────────────────────────────────────

REL_TMP=$(mktemp)
jq -n --arg agent "$AGENT_NAME" '{"agent": $agent}' > "$REL_TMP"
curl -s -X POST "${SERVER_URL}/ubt/release" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Name: ${AGENT_NAME}" \
    -H "X-Project-Id: ${PROJECT_ID}" \
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

# ── Print the output and exit with the server's verdict ──────────────────────

OUTPUT=$(echo "$RESPONSE" | jq -r '.output // "No output received from coordination server"')
STDERR=$(echo "$RESPONSE" | jq -r '.stderr // empty')

echo "$OUTPUT"
if [ -n "$STDERR" ]; then
    echo "$STDERR" >&2
fi

if [ "$SUCCESS" = "true" ]; then
    exit 0
fi
exit 1
