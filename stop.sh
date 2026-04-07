#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Source shared libraries ─────────────────────────────────────────────────
# shellcheck source=scripts/lib/compose-detect.sh
source "$SCRIPT_DIR/scripts/lib/compose-detect.sh"
# shellcheck source=scripts/lib/validators.sh
source "$SCRIPT_DIR/scripts/lib/validators.sh"
# shellcheck source=scripts/lib/stop-helpers.sh
source "$SCRIPT_DIR/scripts/lib/stop-helpers.sh"

# ── Usage ────────────────────────────────────────────────────────────────────
usage() {
  cat <<'USAGE'
Usage: ./stop.sh [OPTIONS]

Stop running Claude Code agent containers.

Options:
  --agent NAME        Stop a specific agent (defaults to 'default' project if --project not specified)
  --team TEAM_ID      Stop all members of a design team and dissolve it
  --project ID        Scope operation to a specific project (multi-project: required with --agent)
  --drain             Graceful shutdown — pause pumps, wait for in-flight
                      tasks, stop containers
  --timeout SECONDS   Max wait time for drain mode (default: 600)
  --help              Show this help message and exit

Modes:
  Default:  Stop all claude-* Docker Compose projects immediately.
  --agent:  Stop only the named agent's container.
  --team:   Stop all members of a design team, then dissolve the team.
            Room and message history are preserved.
  --drain:  Graceful shutdown — pause pumps, wait for in-flight tasks,
            stop containers. You must merge branches and release manually.

Examples:
  ./stop.sh                          # Stop all agents
  ./stop.sh --agent agent-1          # Stop just agent-1
  ./stop.sh --team design-team-1     # Stop a design team
  ./stop.sh --project my-project     # Stop agents in a project
  ./stop.sh --drain                  # Graceful drain then stop
  ./stop.sh --drain --project myproj # Drain only a specific project
  ./stop.sh --drain --timeout 300    # Drain with 5-minute timeout
USAGE
}

# ── Parse flags ──────────────────────────────────────────────────────────────
MODE="default"
AGENT_NAME=""
TEAM_ID=""
PROJECT_ID=""
TIMEOUT=600

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)
      MODE="agent"
      AGENT_NAME="$2"; shift 2 ;;
    --team)
      MODE="team"
      TEAM_ID="$2"; shift 2 ;;
    --project)
      PROJECT_ID="$2"; shift 2 ;;
    --drain)
      MODE="drain"; shift ;;
    --timeout)
      TIMEOUT="$2"; shift 2
      if [[ ! "$TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
        echo "Error: --timeout must be a positive integer" >&2
        exit 1
      fi
      ;;
    --help)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1 ;;
  esac
done

# ── Validate identifiers ────────────────────────────────────────────────────
if [[ -n "$AGENT_NAME" ]]; then
  _validate_identifier "--agent" "$AGENT_NAME" || exit 1
fi

if [[ -n "$TEAM_ID" ]]; then
  _validate_identifier "--team" "$TEAM_ID" || exit 1
fi

if [[ -n "$PROJECT_ID" && ! "$PROJECT_ID" =~ ^[a-zA-Z0-9_-]{1,64}$ ]]; then
  echo "Error: PROJECT_ID contains invalid characters: $PROJECT_ID" >&2
  echo "Only alphanumeric characters, hyphens, and underscores are allowed." >&2
  exit 1
fi

# ── Read port from scaffold.config.json ──────────────────────────────────────
_cfg_port=9100
if [[ -f "$SCRIPT_DIR/scaffold.config.json" ]]; then
    _cfg_port="$(jq -r '.server.port // 9100' "$SCRIPT_DIR/scaffold.config.json" 2>/dev/null || echo 9100)"
fi
if [[ ! "$_cfg_port" =~ ^[0-9]{1,5}$ ]] || (( _cfg_port < 1 || _cfg_port > 65535 )); then
  echo "Error: invalid server port in scaffold.config.json: $_cfg_port" >&2
  exit 1
fi
BASE_URL="http://localhost:$_cfg_port"

# ── Check dependencies ──────────────────────────────────────────────────────
if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not found." >&2
  exit 1
fi

# ── Detect docker compose ───────────────────────────────────────────────────
_detect_compose || exit 1

COMPOSE_DIR="$SCRIPT_DIR/container"

# ── Helper: find all running claude-* projects ──────────────────────────────
_find_claude_projects() {
  local -a projects=()
  mapfile -t projects < <(docker ps --filter "label=com.docker.compose.project" --format '{{index .Labels "com.docker.compose.project"}}' 2>/dev/null | \
    grep -o 'claude-[^ ,]*' | sort -u)

  # When --project is set, filter to only agents registered under that project
  if [[ -n "$PROJECT_ID" && ${#projects[@]} -gt 0 ]]; then
    local project_agents
    project_agents=$(curl -sf "$BASE_URL/agents?project=$PROJECT_ID" --max-time 5 2>/dev/null | \
      jq -r '.[].name' 2>/dev/null) || {
      echo "Error: Could not fetch agents for project $PROJECT_ID from $BASE_URL" >&2
      return 1
    }

    local -a filtered=()
    local prefix="claude-${PROJECT_ID}-"
    local agent_name
    for project in "${projects[@]}"; do
      if [[ "$project" == "${prefix}"* ]]; then
        agent_name="${project#${prefix}}"
        if echo "$project_agents" | grep -qx "$agent_name"; then
          filtered+=("$project")
        fi
      fi
    done
    projects=("${filtered[@]}")
  fi

  # Output project names, one per line
  printf '%s\n' "${projects[@]}"
}

# ── Mode: default — stop all ─────────────────────────────────────────────────
if [[ "$MODE" == "default" ]]; then
  echo "Stopping all Claude agent containers..."
  mapfile -t _projects < <(_find_claude_projects)
  if [[ ${#_projects[@]} -eq 0 ]]; then
    echo "No running claude-* containers found."
    exit 0
  fi
  _signal_and_stop_projects "$BASE_URL" "$COMPOSE_DIR" "$PROJECT_ID" "${_projects[@]}"
  exit 0
fi

# ── Mode: agent — stop specific ──────────────────────────────────────────────
if [[ "$MODE" == "agent" ]]; then
  project_prefix="${PROJECT_ID:-default}"
  compose_project_name="claude-${project_prefix}-${AGENT_NAME}"

  echo "Stopping agent: $AGENT_NAME (project: $project_prefix)..."
  _signal_and_stop_projects "$BASE_URL" "$COMPOSE_DIR" "$project_prefix" "$compose_project_name"
  exit 0
fi

# ── Mode: team — stop all members and dissolve ──────────────────────────────
if [[ "$MODE" == "team" ]]; then
  # Defense-in-depth: re-validate TEAM_ID before use in URLs
  [[ "$TEAM_ID" =~ ^[a-zA-Z0-9_-]{1,64}$ ]] || { echo "Error: invalid TEAM_ID" >&2; exit 1; }

  echo "Stopping team: $TEAM_ID ..."

  # Get team detail from coordination server (includes projectId and members)
  TEAM_RESPONSE=$(curl -sf "$BASE_URL/teams/${TEAM_ID}" 2>/dev/null) || {
    echo "Error: Could not fetch team $TEAM_ID from coordination server at $BASE_URL" >&2
    exit 1
  }

  # Extract projectId from team response; fall back to --project flag or 'default'
  team_project_id=$(echo "$TEAM_RESPONSE" | jq -r '.projectId // empty' 2>/dev/null)
  team_project_id="${team_project_id:-${PROJECT_ID:-default}}"

  if [[ ! "$team_project_id" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo "Error: team_project_id contains invalid characters: $team_project_id" >&2
    exit 1
  fi

  mapfile -t _members < <(echo "$TEAM_RESPONSE" | jq -r '.members[].agentName' 2>/dev/null) || {
    echo "Error: Could not parse member list from team response" >&2
    exit 1
  }

  if [[ ${#_members[@]} -eq 0 ]]; then
    echo "Warning: No members found in team $TEAM_ID" >&2
  fi

  # Build compose project names for each member
  local_projects=()
  for member in "${_members[@]}"; do
    if [[ ! "$member" =~ ^[a-zA-Z0-9_-]{1,64}$ ]]; then
      echo "Warning: skipping member with unexpected name: $member" >&2
      continue
    fi
    local_projects+=("claude-${team_project_id}-${member}")
  done

  if [[ ${#local_projects[@]} -gt 0 ]]; then
    _signal_and_stop_projects "$BASE_URL" "$COMPOSE_DIR" "$team_project_id" "${local_projects[@]}"
  fi

  # Dissolve team
  curl -sf -X DELETE "$BASE_URL/teams/${TEAM_ID}" >/dev/null 2>&1 || {
    echo "Warning: Could not dissolve team on server (may already be dissolved)" >&2
  }

  echo ""
  echo "=== Team Stopped ==="
  echo "  Team:     $TEAM_ID"
  echo "  Stopped:  ${#local_projects[@]} member(s)"
  echo "  Room and message history are preserved."
  exit 0
fi

# ── Mode: drain — graceful shutdown ──────────────────────────────────────────
if [[ "$MODE" == "drain" ]]; then
  echo "=== Drain Mode ==="

  # Build the drain request body (project scoping via X-Project-Id header only)
  drain_body=$(jq -n --argjson timeout "$TIMEOUT" '{timeout: $timeout}')

  # Call the server-side drain endpoint which runs the full state machine
  echo "Requesting drain from coordination server (timeout: ${TIMEOUT}s)..."
  project_header=()
  if [[ -n "$PROJECT_ID" ]]; then
    project_header=(-H "X-Project-Id: $PROJECT_ID")
  fi

  drain_response=$(curl -sf -X POST "${project_header[@]}" \
    -H "Content-Type: application/json" \
    -d "$drain_body" \
    "$BASE_URL/coalesce/drain" \
    --max-time $((TIMEOUT + 30)) 2>/dev/null) || {
    echo "Error: Could not reach coordination server at $BASE_URL for drain" >&2
    exit 1
  }

  timed_out=$(echo "$drain_response" | jq -r '.timedOut')
  paused=$(echo "$drain_response" | jq -r '.paused | join(", ")')
  active=$(echo "$drain_response" | jq -r '.activeTasks')

  echo "  Paused agents: ${paused:-none}"
  if [[ "$timed_out" == "true" ]]; then
    echo "  Warning: Timeout reached with $active active task(s). Proceeding with stop anyway." >&2
  else
    echo "  All tasks complete. Ready to coalesce."
  fi

  # Stop all containers
  echo "Stopping all containers..."
  mapfile -t _projects < <(_find_claude_projects)
  if [[ ${#_projects[@]} -eq 0 ]]; then
    echo "No running claude-* containers found."
  else
    _signal_and_stop_projects "$BASE_URL" "$COMPOSE_DIR" "$PROJECT_ID" "${_projects[@]}"
  fi

  # Print summary with next steps
  echo ""
  echo "=== Drain Complete ==="
  echo ""
  echo "Next steps:"
  echo "  1. Merge agent branches into your main branch"
  echo "  2. Call POST /coalesce/release to clear file ownership"
  echo "  3. Re-launch agents if needed"
  exit 0
fi
