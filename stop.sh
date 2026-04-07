#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
if [[ -n "$AGENT_NAME" && ! "$AGENT_NAME" =~ ^[a-zA-Z0-9_-]{1,64}$ ]]; then
  echo "Error: --agent value contains invalid characters or exceeds 64 chars: $AGENT_NAME" >&2
  exit 1
fi

if [[ -n "$TEAM_ID" && ! "$TEAM_ID" =~ ^[a-zA-Z0-9_-]{1,64}$ ]]; then
  echo "Error: --team value contains invalid characters or exceeds 64 chars: $TEAM_ID" >&2
  exit 1
fi

if [[ -n "$PROJECT_ID" && ! "$PROJECT_ID" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Error: PROJECT_ID contains invalid characters: $PROJECT_ID" >&2
  echo "Only alphanumeric characters, hyphens, and underscores are allowed." >&2
  exit 1
fi

# ── Read port from scaffold.config.json ──────────────────────────────────────
_cfg_port=9100
if [[ -f "$SCRIPT_DIR/scaffold.config.json" ]]; then
    _cfg_port="$(jq -r '.server.port // 9100' "$SCRIPT_DIR/scaffold.config.json" 2>/dev/null || echo 9100)"
fi
BASE_URL="http://localhost:$_cfg_port"

# ── Check dependencies ──────────────────────────────────────────────────────
if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not found." >&2
  exit 1
fi

# ── Detect docker compose ───────────────────────────────────────────────────
COMPOSE_CMD=()
if docker compose version &>/dev/null; then
  COMPOSE_CMD=(docker compose)
elif docker-compose --version &>/dev/null; then
  COMPOSE_CMD=(docker-compose)
else
  echo "Error: Neither 'docker compose' nor 'docker-compose' found." >&2
  exit 1
fi

# ── Helper: signal server to set agent status to 'stopping' ──────────────────
# This must happen BEFORE docker compose down so the container's _shutdown
# handler sees status='stopping' and can hard-delete on its second DELETE call.
signal_stop() {
  local agent_name="$1"
  curl -sf -X DELETE "$BASE_URL/agents/${agent_name}" --max-time 5 >/dev/null 2>&1 || true
}

# ── Helper: stop all claude-* projects ───────────────────────────────────────
stop_all() {
  local stopped=0
  local agent_name

  # Find running containers with claude- project prefix
  local projects
  projects=$(docker ps --filter "label=com.docker.compose.project" --format '{{.Labels}}' 2>/dev/null | \
    grep -oP 'com\.docker\.compose\.project=\Kclaude-[^,]+' | sort -u || true)

  if [[ -z "$projects" ]]; then
    echo "No running claude-* containers found."
    return
  fi

  # When --project is set, filter to only agents registered under that project
  if [[ -n "$PROJECT_ID" ]]; then
    local project_agents
    project_agents=$(curl -sf "$BASE_URL/agents?project=$PROJECT_ID" --max-time 5 2>/dev/null | \
      jq -r '.[].name' 2>/dev/null) || {
      echo "Error: Could not fetch agents for project $PROJECT_ID from $BASE_URL" >&2
      return 1
    }

    local filtered=""
    local prefix="claude-${PROJECT_ID}-"
    for project in $projects; do
      # Extract agent name from docker project (format: claude-${PROJECT_ID}-${AGENT_NAME})
      if [[ "$project" == "${prefix}"* ]]; then
        agent_name="${project#${prefix}}"
        if echo "$project_agents" | grep -qx "$agent_name"; then
          filtered="$filtered $project"
        fi
      fi
    done
    projects="${filtered# }"

    if [[ -z "$projects" ]]; then
      echo "No running containers found for project $PROJECT_ID."
      return
    fi
  fi

  # Signal all agents via server BEFORE killing containers, so the
  # entrypoint's _shutdown handler can complete the two-call DELETE.
  for project in $projects; do
    # Extract agent name from docker project
    if [[ -n "$PROJECT_ID" ]]; then
      agent_name="${project#claude-${PROJECT_ID}-}"
    else
      agent_name="${project#claude-}"
    fi
    signal_stop "$agent_name"
  done

  for project in $projects; do
    echo "Stopping $project ..."
    (cd "$SCRIPT_DIR/container" && "${COMPOSE_CMD[@]}" --project-name "$project" down 2>/dev/null) || true
    stopped=$((stopped + 1))
  done

  echo "Stopped $stopped container(s)."
}

# ── Mode: default — stop all ─────────────────────────────────────────────────
if [[ "$MODE" == "default" ]]; then
  echo "Stopping all Claude agent containers..."
  stop_all
  exit 0
fi

# ── Mode: agent — stop specific ──────────────────────────────────────────────
if [[ "$MODE" == "agent" ]]; then
  # If --project not specified, default to "default" project for backwards compatibility
  project_prefix="${PROJECT_ID:-default}"
  compose_project_name="claude-${project_prefix}-${AGENT_NAME}"

  echo "Stopping agent: $AGENT_NAME (project: $project_prefix)..."
  signal_stop "$AGENT_NAME"
  (cd "$SCRIPT_DIR/container" && \
    "${COMPOSE_CMD[@]}" --project-name "$compose_project_name" down 2>/dev/null) || true
  echo "Stopped $compose_project_name."
  exit 0
fi

# ── Mode: team — stop all members and dissolve ──────────────────────────────
if [[ "$MODE" == "team" ]]; then
  echo "Stopping team: $TEAM_ID ..."

  # Get team member list from coordination server
  TEAM_RESPONSE=$(curl -sf "$BASE_URL/teams/${TEAM_ID}" 2>/dev/null) || {
    echo "Error: Could not fetch team $TEAM_ID from coordination server at $BASE_URL" >&2
    exit 1
  }

  mapfile -t _members < <(echo "$TEAM_RESPONSE" | jq -r '.members[].agentName' 2>/dev/null) || {
    echo "Error: Could not parse member list from team response" >&2
    exit 1
  }

  if [[ ${#_members[@]} -eq 0 ]]; then
    echo "Warning: No members found in team $TEAM_ID" >&2
  fi

  # Signal all members before killing containers
  for member in "${_members[@]}"; do
    signal_stop "$member"
  done

  stopped=0
  for member in "${_members[@]}"; do
    echo "  Stopping claude-${member} ..."
    (cd "$SCRIPT_DIR/container" && \
      "${COMPOSE_CMD[@]}" --project-name "claude-${member}" down 2>/dev/null) || true
    stopped=$((stopped + 1))
  done

  # Dissolve team
  curl -sf -X DELETE "$BASE_URL/teams/${TEAM_ID}" >/dev/null 2>&1 || {
    echo "Warning: Could not dissolve team on server (may already be dissolved)" >&2
  }

  echo ""
  echo "=== Team Stopped ==="
  echo "  Team:     $TEAM_ID"
  echo "  Stopped:  $stopped member(s)"
  echo "  Room and message history are preserved."
  exit 0
fi

# ── Mode: drain — graceful shutdown ──────────────────────────────────────────
if [[ "$MODE" == "drain" ]]; then
  echo "=== Drain Mode ==="

  # 1. Pause pump agents
  echo "Pausing pump agents..."
  project_header=()
  if [[ -n "$PROJECT_ID" ]]; then
    project_header=(-H "X-Project-Id: $PROJECT_ID")
  fi
  pause_response=$(curl -sf -X POST "${project_header[@]}" "$BASE_URL/coalesce/pause" 2>/dev/null) || {
    echo "Error: Could not reach coordination server at $BASE_URL" >&2
    exit 1
  }

  paused=$(echo "$pause_response" | jq -r '.paused | join(", ")')
  in_flight=$(echo "$pause_response" | jq '.inFlightTasks | length')
  echo "  Paused agents: ${paused:-none}"
  echo "  In-flight tasks: $in_flight"

  # 2. Poll until canCoalesce or timeout
  echo "Waiting for in-flight tasks to complete (timeout: ${TIMEOUT}s)..."
  elapsed=0
  poll_interval=5

  while [[ $elapsed -lt $TIMEOUT ]]; do
    status_response=$(curl -sf "${project_header[@]}" "$BASE_URL/coalesce/status" 2>/dev/null) || {
      echo "Warning: Could not reach server, retrying..." >&2
      sleep "$poll_interval"
      elapsed=$((elapsed + poll_interval))
      continue
    }

    can_coalesce=$(echo "$status_response" | jq -r '.canCoalesce')
    if [[ "$can_coalesce" == "true" ]]; then
      echo "  All tasks complete. Ready to coalesce."
      break
    fi

    reason=$(echo "$status_response" | jq -r '.reason // "waiting"')
    echo "  [$elapsed/${TIMEOUT}s] Not ready: $reason"
    sleep "$poll_interval"
    elapsed=$((elapsed + poll_interval))
  done

  if [[ $elapsed -ge $TIMEOUT ]]; then
    echo "Warning: Timeout reached. Proceeding with stop anyway." >&2
  fi

  # 3. Stop all containers
  echo "Stopping all containers..."
  stop_all

  # 4. Print summary with next steps
  echo ""
  echo "=== Drain Complete ==="
  echo ""
  echo "Next steps:"
  echo "  1. Merge agent branches into your main branch"
  echo "  2. Call POST /coalesce/release to clear file ownership"
  echo "  3. Re-launch agents if needed"
  exit 0
fi
