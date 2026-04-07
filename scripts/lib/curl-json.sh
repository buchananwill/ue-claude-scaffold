#!/bin/bash
# scripts/lib/curl-json.sh — JSON HTTP request helpers.
#
# Provides _post_json and _get_json for communicating with the coordination
# server. Uses temp files for POST bodies to avoid shell JSON encoding issues.
# Validates JSON with jq before sending and after receiving.
# Source this file; do not execute it directly.

# Guard against double-sourcing
[[ -n "${_LIB_CURL_JSON_LOADED:-}" ]] && return 0
readonly _LIB_CURL_JSON_LOADED=1

# Source validators for header value validation (SAFETY W1)
# shellcheck source=validators.sh
source "$(dirname "${BASH_SOURCE[0]}")/validators.sh"

# _post_json <url> <body_json>
#   POSTs JSON to <url> using curl. Validates the body as well-formed JSON
#   via jq, writes it to a temp file, and sends it. Includes X-Project-Id and
#   X-Agent-Name headers if the corresponding environment variables are set
#   and pass identifier validation.
#   Prints the response body on stdout. Returns curl's exit code.
_post_json() {
  local url="$1"
  local body="$2"
  local tmpfile
  tmpfile="$(mktemp)"

  # Cleanup is handled explicitly at the end of the function (no RETURN trap).

  # Validate body is well-formed JSON and write compacted form to tmpfile
  if ! printf '%s' "$body" | jq -c '.' > "$tmpfile" 2>/dev/null; then
    echo "Error: _post_json body is not valid JSON" >&2
    rm -f "$tmpfile"
    return 1
  fi

  local -a headers=(-H "Content-Type: application/json")
  if [[ -n "${PROJECT_ID:-}" ]] && _validate_identifier "PROJECT_ID" "$PROJECT_ID" 2>/dev/null; then
    headers+=(-H "X-Project-Id: ${PROJECT_ID}")
  fi
  if [[ -n "${AGENT_NAME:-}" ]] && _validate_identifier "AGENT_NAME" "$AGENT_NAME" 2>/dev/null; then
    headers+=(-H "X-Agent-Name: ${AGENT_NAME}")
  fi

  local rc=0
  curl -sf -X POST "${headers[@]}" -d "@${tmpfile}" "$url" || rc=$?

  rm -f "$tmpfile"
  return "$rc"
}

# _get_json <url>
#   GETs JSON from <url> using curl. Captures the response to a temp file and
#   validates it as well-formed JSON via jq. Prints the validated response body
#   on stdout. Returns curl's exit code, or 1 if the response is not valid JSON.
#   Uses -sf (silent + fail on HTTP errors).
_get_json() {
  local url="$1"
  local tmpfile
  tmpfile="$(mktemp)"

  local rc=0
  curl -sf "$url" > "$tmpfile" || rc=$?

  if [[ "$rc" -ne 0 ]]; then
    rm -f "$tmpfile"
    return "$rc"
  fi

  # Validate response is well-formed JSON
  if ! jq '.' "$tmpfile" 2>/dev/null; then
    echo "Error: _get_json response is not valid JSON" >&2
    rm -f "$tmpfile"
    return 1
  fi

  rm -f "$tmpfile"
  return 0
}
