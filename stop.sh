#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Usage ────────────────────────────────────────────────────────────────────
usage() {
  cat <<'USAGE'
Usage: ./stop.sh [OPTIONS]

Stop running Claude Code agent containers.

Options:
  --agent NAME        Stop a specific agent (project name = claude-NAME)
  --team TEAM_ID      Stop all members of a design team and dissolve it
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
  ./stop.sh --drain                  # Graceful drain then stop
  ./stop.sh --drain --timeout 300    # Drain with 5-minute timeout
USAGE
}

# ── Parse flags ──────────────────────────────────────────────────────────────
MODE="default"
AGENT_NAME=""
TEAM_ID=""
TIMEOUT=600

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)
      MODE="agent"
      AGENT_NAME="$2"; shift 2 ;;
    --team)
      MODE="team"
      TEAM_ID="$2"; shift 2 ;;
    --drain)
      MODE="drain"; shift ;;
    --timeout)
      TIMEOUT="$2"; shift 2 ;;
    --help)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1 ;;
  esac
done

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
COMPOSE_CMD=""
if docker compose version &>/dev/null; then
  COMPOSE_CMD="docker compose"
elif docker-compose --version &>/dev/null; then
  COMPOSE_CMD="docker-compose"
else
  echo "Error: Neither 'docker compose' nor 'docker-compose' found." >&2
  exit 1
fi

# ── Helper: stop all claude-* projects ───────────────────────────────────────
stop_all() {
  local compose_file="$SCRIPT_DIR/container/docker-compose.yml"
  local stopped=0

  # Find running containers with claude- project prefix
  local projects
  projects=$(docker ps --filter "label=com.docker.compose.project" --format '{{.Labels}}' 2>/dev/null | \
    grep -oP 'com\.docker\.compose\.project=\Kclaude-[^,]+' | sort -u || true)

  if [[ -z "$projects" ]]; then
    echo "No running claude-* containers found."
    return
  fi

  for project in $projects; do
    echo "Stopping $project ..."
    (cd "$SCRIPT_DIR/container" && $COMPOSE_CMD --project-name "$project" down 2>/dev/null) || true
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
  echo "Stopping agent: $AGENT_NAME ..."
  (cd "$SCRIPT_DIR/container" && \
    $COMPOSE_CMD --project-name "claude-${AGENT_NAME}" down 2>/dev/null) || true
  echo "Stopped claude-${AGENT_NAME}."
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

  MEMBERS=$(echo "$TEAM_RESPONSE" | jq -r '.members[].agentName' 2>/dev/null) || {
    echo "Error: Could not parse member list from team response" >&2
    exit 1
  }

  stopped=0
  for member in $MEMBERS; do
    echo "  Stopping claude-${member} ..."
    (cd "$SCRIPT_DIR/container" && \
      $COMPOSE_CMD --project-name "claude-${member}" down 2>/dev/null) || true
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
  pause_response=$(curl -sf -X POST "$BASE_URL/coalesce/pause" 2>/dev/null) || {
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
    status_response=$(curl -sf "$BASE_URL/coalesce/status" 2>/dev/null) || {
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
