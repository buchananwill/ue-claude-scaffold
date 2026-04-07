#!/usr/bin/env bash
# scripts/lib/curl-json.sh — JSON HTTP request helpers.
#
# Provides _post_json and _get_json for communicating with the coordination
# server. Uses temp files for POST bodies to avoid shell JSON encoding issues.
# Source this file; do not execute it directly.

# Guard against double-sourcing
[[ -n "${_LIB_CURL_JSON_LOADED:-}" ]] && return 0
readonly _LIB_CURL_JSON_LOADED=1

# _post_json <url> <body_json>
#   POSTs JSON to <url> using curl. Writes the body to a temp file to avoid
#   shell quoting issues. Includes X-Project-Id and X-Agent-Name headers if
#   the corresponding environment variables are set.
#   Prints the response body on stdout. Returns curl's exit code.
_post_json() {
  local url="$1"
  local body="$2"
  local tmpfile
  tmpfile="$(mktemp)"

  # Ensure cleanup on return (not EXIT — we don't want to clobber the caller's trap)
  # shellcheck disable=SC2064
  trap "rm -f '$tmpfile'" RETURN 2>/dev/null || true

  printf '%s' "$body" > "$tmpfile"

  local -a headers=(-H "Content-Type: application/json")
  if [[ -n "${PROJECT_ID:-}" ]]; then
    headers+=(-H "X-Project-Id: ${PROJECT_ID}")
  fi
  if [[ -n "${AGENT_NAME:-}" ]]; then
    headers+=(-H "X-Agent-Name: ${AGENT_NAME}")
  fi

  local rc=0
  curl -s -X POST "${headers[@]}" -d "@${tmpfile}" "$url" || rc=$?

  rm -f "$tmpfile"
  return "$rc"
}

# _get_json <url>
#   GETs JSON from <url> using curl. Prints the response body on stdout.
#   Returns curl's exit code. Uses -sf (silent + fail on HTTP errors).
_get_json() {
  local url="$1"
  curl -sf "$url"
}
