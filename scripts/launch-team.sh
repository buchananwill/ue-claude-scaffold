#!/bin/bash
# scripts/launch-team.sh -- Server-side team launch
#
# Called by launch.sh via exec when --team is set. Delegates team setup
# (validation, DB registration, branch creation) to the coordination server
# via POST /teams/:id/launch, then launches one container per member.
#
# Expected environment (set by launch.sh before exec-ing this script):
#   _CLI_TEAM          -- team definition filename (without .json)
#   _CLI_BRIEF         -- repo-relative path to the brief file
#   PROJECT_ID         -- project identifier
#   SERVER_PORT        -- coordination server port
#   SCRIPT_DIR         -- path to the repo root (where teams/ lives)
#   BARE_REPO_PATH     -- path to the bare repo
#   UE_ENGINE_PATH     -- Unreal Engine path
#   CLAUDE_CREDENTIALS_PATH -- Claude credentials mount path
#   AGENTS_PATH        -- compiled agents directory
#   MAX_TURNS          -- max agent turns
#   LOG_VERBOSITY      -- verbosity level
set -euo pipefail

# -- Validate required vars --------------------------------------------------
if [[ -z "${_CLI_TEAM:-}" ]]; then
  echo "Error: _CLI_TEAM is not set" >&2; exit 1
fi
if [[ -z "${_CLI_BRIEF:-}" ]]; then
  echo "Error: --brief is required when using --team" >&2; exit 1
fi
if [[ -z "${SERVER_PORT:-}" ]]; then
  echo "Error: SERVER_PORT is not set" >&2; exit 1
fi
if [[ -z "${SCRIPT_DIR:-}" ]]; then
  echo "Error: SCRIPT_DIR is not set" >&2; exit 1
fi

# -- Detect docker compose ---------------------------------------------------
COMPOSE_CMD=()
if docker compose version &>/dev/null; then
  COMPOSE_CMD=(docker compose)
elif docker-compose --version &>/dev/null; then
  COMPOSE_CMD=(docker-compose)
else
  echo "Error: Neither 'docker compose' nor 'docker-compose' found." >&2
  exit 1
fi

echo "=== Launching Team: $_CLI_TEAM ==="
echo "  Brief: $_CLI_BRIEF"
echo ""

# -- Call the server-side launch endpoint ------------------------------------
LAUNCH_RESPONSE=$(curl -sf -X POST "http://localhost:${SERVER_PORT}/teams/${_CLI_TEAM}/launch" \
  -H "Content-Type: application/json" \
  -H "X-Project-Id: ${PROJECT_ID}" \
  -d "$(jq -n \
    --arg projectId "$PROJECT_ID" \
    --arg briefPath "$_CLI_BRIEF" \
    '{projectId: $projectId, briefPath: $briefPath}')" \
  2>&1) || {
  echo "Error: Team launch request failed." >&2
  echo "  Ensure the coordination server is running on port ${SERVER_PORT}." >&2
  exit 1
}

# Validate response
if ! echo "$LAUNCH_RESPONSE" | jq -e '.ok' >/dev/null 2>&1; then
  _err_msg=$(echo "$LAUNCH_RESPONSE" | jq -r '.message // .error // "unknown error"' 2>/dev/null || echo "unexpected response format")
  echo "Error: Team launch returned: ${_err_msg}" >&2
  exit 1
fi

ROOM_ID=$(echo "$LAUNCH_RESPONSE" | jq -r '.roomId')
MEMBER_COUNT=$(echo "$LAUNCH_RESPONSE" | jq -r '.members | length')

echo "  Room:    $ROOM_ID"
echo "  Members: $MEMBER_COUNT"
echo ""

# -- Launch containers for each member ----------------------------------------
# Leader must be first in the array (server sorts leader-first).
# Extract and verify the leader before launching anyone.
_LEADER_JSON=$(echo "$LAUNCH_RESPONSE" | jq -c '.members[0]')
_LEADER_CHECK=$(echo "$_LEADER_JSON" | jq -r '.isLeader')
if [[ "$_LEADER_CHECK" != "true" ]]; then
  echo "Error: first member in launch response is not the leader (isLeader=$_LEADER_CHECK)." >&2
  echo "  The server must return leader-first ordering." >&2
  exit 1
fi

FIRST=true
while IFS= read -r member; do
  _NAME=$(echo "$member" | jq -r '.agentName')
  if [[ ! "$_NAME" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo "Error: server returned invalid agentName: $_NAME" >&2
    exit 1
  fi
  _TYPE=$(echo "$member" | jq -r '.agentType')
  if [[ ! "$_TYPE" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo "Error: server returned invalid agentType: $_TYPE" >&2; exit 1
  fi
  _BRANCH=$(echo "$member" | jq -r '.branch')
  if [[ ! "$_BRANCH" =~ ^docker/[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+$ ]]; then
    echo "Error: server returned invalid branch: $_BRANCH" >&2; exit 1
  fi
  _ROLE=$(echo "$member" | jq -r '.role')
  # Spaces are intentionally allowed in role names (e.g. "team lead", "tech writer")
  if [[ ! "$_ROLE" =~ ^[a-zA-Z0-9\ _-]{1,128}$ ]]; then
    echo "Error: server returned invalid role: $_ROLE" >&2; exit 1
  fi
  _IS_LEADER=$(echo "$member" | jq -r '.isLeader')
  _HOOK_BUILD=$(echo "$member" | jq -r '.hooks.buildIntercept')
  _HOOK_LINT=$(echo "$member" | jq -r '.hooks.cppLint')

  # Stop existing container if running
  (cd "$SCRIPT_DIR/container" && \
    "${COMPOSE_CMD[@]}" --project-name "claude-${PROJECT_ID}-${_NAME}" down 2>/dev/null) || true

  # Launch container (inline docker compose invocation)
  (cd "$SCRIPT_DIR/container" && env \
    AGENT_NAME="$_NAME" \
    WORK_BRANCH="$_BRANCH" \
    AGENT_TYPE="$_TYPE" \
    PROJECT_ID="$PROJECT_ID" \
    CHAT_ROOM="$ROOM_ID" \
    TEAM_ROLE="$_ROLE" \
    BRIEF_PATH="$_CLI_BRIEF" \
    BARE_REPO_PATH="$BARE_REPO_PATH" \
    UE_ENGINE_PATH="${UE_ENGINE_PATH:-}" \
    CLAUDE_CREDENTIALS_PATH="${CLAUDE_CREDENTIALS_PATH:-}" \
    AGENTS_PATH="${AGENTS_PATH:-}" \
    SERVER_PORT="$SERVER_PORT" \
    MAX_TURNS="${MAX_TURNS:-200}" \
    LOG_VERBOSITY="${LOG_VERBOSITY:-normal}" \
    WORKER_MODE=false \
    HOOK_BUILD_INTERCEPT="$_HOOK_BUILD" \
    HOOK_CPP_LINT="$_HOOK_LINT" \
    "${COMPOSE_CMD[@]}" --project-name "claude-${PROJECT_ID}-${_NAME}" up --build --detach)

  echo "  Launched $_NAME (role: $_ROLE, type: $_TYPE, leader: $_IS_LEADER)"

  # Wait between leader and other members
  if [[ "$FIRST" == "true" && "$_IS_LEADER" == "true" ]]; then
    FIRST=false
    echo "  Waiting 10s before launching other members..."
    sleep 10
  fi
done < <(echo "$LAUNCH_RESPONSE" | jq -c '.members[]')

echo ""
echo "=== Team Launched ==="
echo "  Room: $ROOM_ID"
echo ""
echo "Monitor progress:"
echo "  ./status.sh --follow"
echo ""
echo "Stop team:"
echo "  ./stop.sh --team $_CLI_TEAM"
exit 0
