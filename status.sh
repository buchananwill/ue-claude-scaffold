#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Usage ────────────────────────────────────────────────────────────────────
usage() {
  cat <<'USAGE'
Usage: ./status.sh [OPTIONS]

Show the status of running agents and recent messages from the coordination server.

Options:
  --follow [SECONDS]  Continuously refresh (default interval: 5s)
  --since ID          Only show messages with id > ID (default: 0)
  --project ID        Scope output to a specific project
  --help              Show this help message and exit

Examples:
  ./status.sh
  ./status.sh --follow
  ./status.sh --follow 10
  ./status.sh --since 42
  ./status.sh --project my-project
USAGE
}

# ── Parse flags ──────────────────────────────────────────────────────────────
FOLLOW=false
INTERVAL=5
CURSOR=0
PROJECT_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --follow)
      FOLLOW=true
      shift
      if [[ $# -gt 0 && "$1" =~ ^[0-9]+$ ]]; then
        INTERVAL="$1"; shift
      fi
      ;;
    --since)
      if [[ -z "${2:-}" || ! "$2" =~ ^[0-9]+$ ]]; then
        echo "Error: --since requires a non-negative integer argument" >&2
        exit 1
      fi
      CURSOR="$2"; shift 2 ;;
    --project)
      PROJECT_ID="$2"; shift 2 ;;
    --help)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1 ;;
  esac
done

# ── Validate PROJECT_ID ─────────────────────────────────────────────────────
if [[ -n "$PROJECT_ID" && ! "$PROJECT_ID" =~ ^[a-zA-Z0-9_-]{1,64}$ ]]; then
  echo "Error: PROJECT_ID must be 1-64 alphanumeric, hyphen, or underscore characters: $PROJECT_ID" >&2
  exit 1
fi

# ── Read port from scaffold.config.json ──────────────────────────────────────
_cfg_port=9100
if [[ -f "$SCRIPT_DIR/scaffold.config.json" ]]; then
    _cfg_port="$(jq -r '.server.port // 9100' "$SCRIPT_DIR/scaffold.config.json" 2>/dev/null || echo 9100)"
fi

if [[ "$_cfg_port" -lt 1 || "$_cfg_port" -gt 65535 ]] 2>/dev/null; then
  echo "Error: Invalid port number: $_cfg_port (must be 1-65535)" >&2
  exit 1
fi

BASE_URL="http://localhost:$_cfg_port"

# ── Check dependencies ──────────────────────────────────────────────────────
if ! command -v curl &>/dev/null; then
  echo "Error: curl is required but not found." >&2
  exit 1
fi
if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not found." >&2
  echo "Install it: https://jqlang.github.io/jq/download/" >&2
  exit 1
fi

# ── Color support ────────────────────────────────────────────────────────────
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

_status_color() {
  case "$1" in
    working)  printf '%b' "${C_YELLOW}$1${C_RESET}" ;;
    done)     printf '%b' "${C_GREEN}$1${C_RESET}" ;;
    error)    printf '%b' "${C_RED}$1${C_RESET}" ;;
    idle)     printf '%b' "${C_DIM}$1${C_RESET}" ;;
    *)        printf '%s' "$1" ;;
  esac
}
_task_status_color() {
  local status="$1" color=""
  case "$status" in
    pending)              color="$C_DIM" ;;
    claimed|in_progress)  color="$C_YELLOW" ;;
    completed)            color="$C_GREEN" ;;
    failed)               color="$C_RED" ;;
  esac
  [[ -n "$color" ]] && printf '%b' "${color}${status}${C_RESET}" || printf '%s' "$status"
}

# Note: agent names and task titles are validated server-side
# (alphanumeric, hyphens, underscores only), so terminal escape injection
# is not a concern for these fields.

_print_agent_row() {
  local name="$1" project="$2" worktree="$3" status="$4" registered="$5"
  local colored_status
  colored_status=$(_status_color "$status")
  if [[ -n "$SHOW_PROJECT" ]]; then
    printf "  %-15s %-20s %-25s %b %s\n" "$name" "$project" "$worktree" "$colored_status" "$registered"
  else
    printf "  %-15s %-25s %b %s\n" "$name" "$worktree" "$colored_status" "$registered"
  fi
}

_print_task_row() {
  local id="$1" pri="$2" status="$3" project="$4" claimed="$5" title="$6"
  local colored_status
  colored_status=$(_task_status_color "$status")
  if [[ -n "$SHOW_PROJECT" ]]; then
    printf "  %-4s  %-4s  %-12b  %-15s  %-12s  %s\n" "$id" "$pri" "$colored_status" "$project" "$claimed" "$title"
  else
    printf "  %-4s  %-4s  %-12b  %-12s  %s\n" "$id" "$pri" "$colored_status" "$claimed" "$title"
  fi
}

# ── Print status ─────────────────────────────────────────────────────────────
# SHOW_PROJECT is set when no --project filter is active (show project column)
SHOW_PROJECT=""
[[ -z "$PROJECT_ID" ]] && SHOW_PROJECT="1"

print_status() {
  # Build status URL — project scoping is via X-Project-Id header only
  local status_url="$BASE_URL/status?since=$CURSOR&taskLimit=20"

  local status_json
  if ! status_json=$(curl -sf "$status_url" \
    -H "X-Project-Id: ${PROJECT_ID:-default}" \
    --max-time 5 2>/dev/null); then
    printf '%b\n' "${C_RED}Server unreachable at $BASE_URL${C_RESET}"
    echo "Start the coordination server: cd server && npm run dev"
    return
  fi

  # ── Agents ──
  printf '%b\n' "${C_BOLD}=== Agents ===${C_RESET}"
  local agent_count
  agent_count=$(echo "$status_json" | jq '.agents | length')

  if [[ "$agent_count" -eq 0 ]]; then
    echo "  No agents registered."
  else
    if [[ -n "$SHOW_PROJECT" ]]; then
      printf "  %-15s %-20s %-25s %-10s %s\n" "NAME" "PROJECT" "WORKTREE" "STATUS" "REGISTERED"
      printf "  %-15s %-20s %-25s %-10s %s\n" "----" "-------" "--------" "------" "----------"
    else
      printf "  %-15s %-25s %-10s %s\n" "NAME" "WORKTREE" "STATUS" "REGISTERED"
      printf "  %-15s %-25s %-10s %s\n" "----" "--------" "------" "----------"
    fi
    echo "$status_json" | jq -r '.agents[] | "\(.name)\t\(.projectId // "-")\t\(.worktree // "-")\t\(.status // "idle")\t\(.registeredAt // "-")"' | \
    while IFS=$'\t' read -r name project worktree status registered; do
      _print_agent_row "$name" "$project" "$worktree" "$status" "$registered"
    done
  fi

  echo ""

  # ── Tasks ──
  printf '%b\n' "${C_DIM}--- Tasks --------------------------------------------------${C_RESET}"
  local task_count
  task_count=$(echo "$status_json" | jq '.tasks.items | length')

  if [[ "$task_count" -eq 0 ]]; then
    echo "  No tasks."
  else
    if [[ -n "$SHOW_PROJECT" ]]; then
      printf "  ${C_DIM}%-4s  %-4s  %-12s  %-15s  %-12s  %s${C_RESET}\n" "ID" "PRI" "STATUS" "PROJECT" "CLAIMED BY" "TITLE"
    else
      printf "  ${C_DIM}%-4s  %-4s  %-12s  %-12s  %s${C_RESET}\n" "ID" "PRI" "STATUS" "CLAIMED BY" "TITLE"
    fi
    echo "$status_json" | jq -r '.tasks.items[] | [.id, .priority, .status, (.projectId // "-"), (.claimedBy // "-"), .title] | @tsv' | \
    while IFS=$'\t' read -r id pri status project claimed title; do
      _print_task_row "$id" "$pri" "$status" "$project" "$claimed" "$title"
    done
  fi

  echo ""

  # ── Messages ──
  printf '%b\n' "${C_BOLD}=== Messages (since #$CURSOR) ===${C_RESET}"
  local msg_count
  msg_count=$(echo "$status_json" | jq '.messages | length')

  if [[ "$msg_count" -eq 0 ]]; then
    echo "  No new messages."
  else
    echo "$status_json" | jq -r '.messages[] | "\(.id)\t\(.createdAt // "-")\t\(.fromAgent // "-")\t\(.type // "-")\t\(.payload | tostring)"' | \
    while IFS=$'\t' read -r id timestamp agent type payload; do
      # summary is not declared local here — we are inside a piped subshell
      # where local is redundant
      if [[ "$type" == "summary" ]]; then
        summary=$(echo "$payload" | jq -r '.summary // .' 2>/dev/null || echo "$payload")
        printf '  [%b] %b  %s\n' "${C_DIM}${timestamp}${C_RESET}" "${C_BOLD}${agent}${C_RESET}" "$type"
        echo "$summary" | sed 's/^/    /'
      else
        summary=$(echo "$payload" | jq -r 'if type == "object" then (to_entries | map("\(.key)=\(.value)") | join(", ")) else . end' 2>/dev/null || echo "$payload")
        printf '  [%b] %b  %s  %s\n' "${C_DIM}${timestamp}${C_RESET}" "${C_BOLD}${agent}${C_RESET}" "$type" "$summary"
      fi
    done

    # Update cursor to max id — intentionally mutates the global CURSOR so
    # subsequent iterations in --follow mode only fetch newer messages.
    local max_id
    max_id=$(echo "$status_json" | jq '[.messages[].id] | max')
    if [[ "$max_id" != "null" && -n "$max_id" ]]; then
      CURSOR="$max_id"
    fi
  fi

  echo ""
  printf '%b\n' "${C_DIM}Last updated: $(date +%H:%M:%S)${C_RESET}"
}

# ── Main ─────────────────────────────────────────────────────────────────────
if [[ "$FOLLOW" == true ]]; then
  trap 'echo ""; echo "Stopped."; exit 0' SIGINT

  while true; do
    if [[ -t 1 ]]; then
      clear
    fi
    print_status
    sleep "$INTERVAL"
  done
else
  print_status
fi
