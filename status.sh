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
  --help              Show this help message and exit

Examples:
  ./status.sh
  ./status.sh --follow
  ./status.sh --follow 10
  ./status.sh --since 42
USAGE
}

# ── Parse flags ──────────────────────────────────────────────────────────────
FOLLOW=false
INTERVAL=5
CURSOR=0

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
      CURSOR="$2"; shift 2 ;;
    --help)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1 ;;
  esac
done

# ── Source .env for SERVER_PORT ──────────────────────────────────────────────
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

BASE_URL="http://localhost:${SERVER_PORT:-9100}"

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

status_color() {
  case "$1" in
    working)  echo -e "${C_YELLOW}$1${C_RESET}" ;;
    done)     echo -e "${C_GREEN}$1${C_RESET}" ;;
    error)    echo -e "${C_RED}$1${C_RESET}" ;;
    idle)     echo -e "${C_DIM}$1${C_RESET}" ;;
    *)        echo "$1" ;;
  esac
}

# ── Print status ─────────────────────────────────────────────────────────────
print_status() {
  # Fetch agents
  local agents_json
  if ! agents_json=$(curl -sf "$BASE_URL/agents" 2>/dev/null); then
    echo -e "${C_RED}Server unreachable at $BASE_URL${C_RESET}"
    echo "Start the coordination server: cd server && npm run dev"
    return
  fi

  # Agent table
  echo -e "${C_BOLD}=== Agents ===${C_RESET}"
  local agent_count
  agent_count=$(echo "$agents_json" | jq 'length')

  if [[ "$agent_count" -eq 0 ]]; then
    echo "  No agents registered."
  else
    printf "  %-15s %-25s %-10s %s\n" "NAME" "WORKTREE" "STATUS" "REGISTERED"
    printf "  %-15s %-25s %-10s %s\n" "----" "--------" "------" "----------"
    echo "$agents_json" | jq -r '.[] | "\(.name)\t\(.worktree // "-")\t\(.status // "idle")\t\(.registered_at // "-")"' | while IFS=$'\t' read -r name branch status registered; do
      local colored_status
      colored_status=$(status_color "$status")
      printf "  %-15s %-25s %-10b %s\n" "$name" "$branch" "$colored_status" "$registered"
    done
  fi

  echo ""

  # ── Tasks ──
  echo ""
  echo -e "${C_DIM}--- Tasks --------------------------------------------------${C_RESET}"

  local tasks_json
  if tasks_json=$(curl -sf "$BASE_URL/tasks?limit=20" --max-time 5 2>/dev/null); then
    local task_count
    task_count=$(echo "$tasks_json" | jq 'length')

    if [[ "$task_count" -eq 0 ]]; then
      echo "  No tasks."
    else
      printf "  ${C_DIM}%-4s  %-4s  %-12s  %-12s  %s${C_RESET}\n" "ID" "PRI" "STATUS" "CLAIMED BY" "TITLE"
      echo "$tasks_json" | jq -r '.[] | [.id, .priority, .status, (.claimedBy // "-"), .title] | @tsv' | \
      while IFS=$'\t' read -r id pri status claimed title; do
        local color=""
        case "$status" in
          pending)     color="$C_DIM" ;;
          claimed|in_progress) color="$C_YELLOW" ;;
          completed)   color="$C_GREEN" ;;
          failed)      color="$C_RED" ;;
          *)           color="" ;;
        esac
        printf "  %-4s  %-4s  ${color}%-12s${C_RESET}  %-12s  %s\n" "$id" "$pri" "$status" "$claimed" "$title"
      done
    fi
  else
    echo "  Could not fetch tasks."
  fi

  echo ""

  # Fetch messages
  local messages_json
  if messages_json=$(curl -sf "$BASE_URL/messages/general?since=$CURSOR" 2>/dev/null); then
    local msg_count
    msg_count=$(echo "$messages_json" | jq 'length')

    echo -e "${C_BOLD}=== Messages (since #$CURSOR) ===${C_RESET}"

    if [[ "$msg_count" -eq 0 ]]; then
      echo "  No new messages."
    else
      echo "$messages_json" | jq -r '.[] | "\(.id)\t\(.timestamp // .createdAt // "-")\t\(.agent // "-")\t\(.type // "-")\t\(.payload | tostring)"' | while IFS=$'\t' read -r id timestamp agent type payload; do
        local summary
        if [[ "$type" == "summary" ]]; then
          summary=$(echo "$payload" | jq -r '.summary // .' 2>/dev/null || echo "$payload")
          echo -e "  [${C_DIM}${timestamp}${C_RESET}] ${C_BOLD}${agent}${C_RESET}  ${type}"
          echo "$summary" | sed 's/^/    /'
        else
          summary=$(echo "$payload" | jq -r 'if type == "object" then (to_entries | map("\(.key)=\(.value)") | join(", ")) else . end' 2>/dev/null || echo "$payload")
          echo -e "  [${C_DIM}${timestamp}${C_RESET}] ${C_BOLD}${agent}${C_RESET}  ${type}  ${summary}"
        fi
      done

      # Update cursor to max id
      local max_id
      max_id=$(echo "$messages_json" | jq '[.[].id] | max')
      if [[ "$max_id" != "null" && -n "$max_id" ]]; then
        CURSOR="$max_id"
      fi
    fi
  else
    echo "  Could not fetch messages."
  fi

  echo ""
  echo -e "${C_DIM}Last updated: $(date +%H:%M:%S)${C_RESET}"
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
