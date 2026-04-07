#!/bin/bash
# scripts/lib/validators.sh — Input validation helpers.
#
# Provides identifier and branch name validation used across all shell scripts.
# Source this file; do not execute it directly.

# Guard against double-sourcing
[[ -n "${_LIB_VALIDATORS_LOADED:-}" ]] && return 0
readonly _LIB_VALIDATORS_LOADED=1

# _validate_identifier <label> <value>
#   Validates that <value> matches ^[a-zA-Z0-9_-]{1,64}$.
#   On failure, prints an error to stderr and returns 1.
_validate_identifier() {
  local label="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[a-zA-Z0-9_-]{1,64}$ ]]; then
    echo "Error: ${label} contains invalid characters or exceeds 64 chars: ${value}" >&2
    return 1
  fi
  return 0
}

# _validate_branch_name <value>
#   Validates that <value> is a legal git branch name per the project convention.
#   Mirrors the regex in server/src/branch-naming.ts (BRANCH_RE).
#   On failure, prints an error to stderr and returns 1.
_validate_branch_name() {
  local value="$1"

  # Length check: 1..200 characters, only allowed characters.
  # Character class must match BRANCH_RE in server/src/branch-naming.ts: [a-zA-Z0-9/_.-]
  if [[ ! "$value" =~ ^[a-zA-Z0-9/_.-]{1,200}$ ]]; then
    echo "Error: branch name contains invalid characters or exceeds 200 chars: ${value}" >&2
    return 1
  fi

  # Must not start with -
  if [[ "$value" =~ ^- ]]; then
    echo "Error: branch name must not start with '-': ${value}" >&2
    return 1
  fi

  # Must not start with . or /
  if [[ "$value" =~ ^[./] ]]; then
    echo "Error: branch name must not start with '.' or '/': ${value}" >&2
    return 1
  fi

  # Must not contain //
  if [[ "$value" == *"//"* ]]; then
    echo "Error: branch name must not contain '//': ${value}" >&2
    return 1
  fi

  # Must not contain ..
  if [[ "$value" == *".."* ]]; then
    echo "Error: branch name must not contain '..': ${value}" >&2
    return 1
  fi

  # Must not end with .
  if [[ "$value" == *"." ]]; then
    echo "Error: branch name must not end with '.': ${value}" >&2
    return 1
  fi

  # Must not end with /
  if [[ "$value" == *"/" ]]; then
    echo "Error: branch name must not end with '/': ${value}" >&2
    return 1
  fi

  # Must not contain .lock/ or end with .lock
  if [[ "$value" =~ \.lock(/|$) ]]; then
    echo "Error: branch name must not contain '.lock' component: ${value}" >&2
    return 1
  fi

  # Must not contain /. (hidden path component)
  if [[ "$value" == *"/."* ]]; then
    echo "Error: branch name must not contain '/.': ${value}" >&2
    return 1
  fi

  # Must not contain ./
  if [[ "$value" == *"./"* ]]; then
    echo "Error: branch name must not contain './': ${value}" >&2
    return 1
  fi

  return 0
}

# _read_server_port <script_dir>
#   Reads the coordination server port from scaffold.config.json.
#   Falls back to 9100 if the file is absent or the key is missing.
#   Validates the port is in the range 1-65535.
#   Echoes the port number on success; returns 1 on validation failure.
_read_server_port() {
  local script_dir="$1"
  local port=9100

  if [[ -f "$script_dir/scaffold.config.json" ]]; then
    port="$(jq -r '.server.port // 9100' -- "$script_dir/scaffold.config.json" 2>/dev/null || echo 9100)"
  fi

  if [[ ! "$port" =~ ^[1-9][0-9]{0,4}$ ]] || (( port < 1 || port > 65535 )); then
    echo "Error: invalid server port in scaffold.config.json: $port" >&2
    return 1
  fi

  echo "$port"
}
