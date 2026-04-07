#!/bin/bash
# scripts/lib/colors.sh — Terminal color support and status colorization.
#
# Sets color variables based on terminal capability and NO_COLOR env var.
# Provides _status_color() for colorizing agent status strings.
# Source this file; do not execute it directly.

# Guard against double-sourcing
[[ -n "${_LIB_COLORS_LOADED:-}" ]] && return 0
readonly _LIB_COLORS_LOADED=1

# ── Color variables ──────────────────────────────────────────────────────────
# Respect NO_COLOR (https://no-color.org/) and non-TTY output.
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET='\033[0m'
  C_BOLD='\033[1m'
  C_DIM='\033[2m'
  C_YELLOW='\033[33m'
  C_GREEN='\033[32m'
  C_RED='\033[31m'
else
  C_RESET=''
  C_BOLD=''
  C_DIM=''
  C_YELLOW=''
  C_GREEN=''
  C_RED=''
fi

# _status_color <status>
#   Prints the status string with appropriate color escapes.
_status_color() {
  case "$1" in
    working)  echo -e "${C_YELLOW}$1${C_RESET}" ;;
    done)     echo -e "${C_GREEN}$1${C_RESET}" ;;
    error)    echo -e "${C_RED}$1${C_RESET}" ;;
    idle)     echo -e "${C_DIM}$1${C_RESET}" ;;
    *)        echo "$1" ;;
  esac
}
