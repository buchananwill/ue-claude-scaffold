#!/bin/bash
# scripts/lib/compose-detect.sh — Docker Compose command detection.
#
# Detects whether "docker compose" (V2 plugin) or "docker-compose" (standalone)
# is available and sets COMPOSE_CMD accordingly.
# Source this file; do not execute it directly.

# Guard against double-sourcing
[[ -n "${_LIB_COMPOSE_DETECT_LOADED:-}" ]] && return 0
readonly _LIB_COMPOSE_DETECT_LOADED=1

# _detect_compose
#   Sets the global COMPOSE_CMD variable to the available docker compose command.
#   Returns 1 and prints an error to stderr if neither variant is found.
_detect_compose() {
  COMPOSE_CMD=()
  if docker compose version &>/dev/null; then
    COMPOSE_CMD=(docker compose)
  elif docker-compose --version &>/dev/null; then
    COMPOSE_CMD=(docker-compose)
  else
    echo "Error: Neither 'docker compose' nor 'docker-compose' found." >&2
    return 1
  fi
}
