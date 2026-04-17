#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v jq &>/dev/null; then
    echo "Error: jq is required but not found." >&2
    echo "Install it: winget install jqlang.jq (Windows) or apt-get install jq (Linux)" >&2
    exit 1
fi

# ── Source libraries ─────────────────────────────────────────────────────────
source "$SCRIPT_DIR/scripts/lib/parse-launch-args.sh"
source "$SCRIPT_DIR/scripts/lib/compose-detect.sh"
source "$SCRIPT_DIR/scripts/lib/resolve-config.sh"
source "$SCRIPT_DIR/scripts/lib/resolve-hooks.sh"
source "$SCRIPT_DIR/scripts/lib/compile-agents.sh"
source "$SCRIPT_DIR/scripts/lib/branch-setup.sh"
source "$SCRIPT_DIR/scripts/lib/launch-container.sh"
source "$SCRIPT_DIR/scripts/lib/print-resolved-config.sh"

# ── Parse CLI ────────────────────────────────────────────────────────────────
_parse_launch_args "$@"

# ── Load .env ────────────────────────────────────────────────────────────────
if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
  echo "Error: .env not found at $SCRIPT_DIR/.env" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source "$SCRIPT_DIR/.env"
set +a

# ── Resolve project config ──────────────────────────────────────────────────
PROJECT_ID="${_CLI_PROJECT:-default}"
_validate_identifier "PROJECT_ID" "$PROJECT_ID" || exit 1

_resolve_project_config "$SCRIPT_DIR" "$PROJECT_ID"
_resolve_agent_vars
_validate_required_config "$SCRIPT_DIR/scaffold.config.json"

export BARE_REPO_PATH UE_ENGINE_PATH PROJECT_PATH CLAUDE_CREDENTIALS_PATH SERVER_PORT LOGS_PATH PROJECT_ID

# ── Detect docker compose ───────────────────────────────────────────────────
_detect_compose || exit 1

# ── Resolve hooks ────────────────────────────────────────────────────────────
if [[ -n "$_CLI_TEAM" && -f "$SCRIPT_DIR/teams/${_CLI_TEAM}.json" ]]; then
  TEAM_DEF="$SCRIPT_DIR/teams/${_CLI_TEAM}.json"
fi
_resolve_hooks ""

# ── Dry run ──────────────────────────────────────────────────────────────────
if [[ "$_CLI_DRY_RUN" == true ]]; then
  echo "=== Dry Run ==="
  _print_resolved_config
  exit 0
fi

# ── Check coordination server ───────────────────────────────────────────────
if ! curl -sf "http://localhost:${SERVER_PORT:-9100}/health" >/dev/null 2>&1; then
  echo "Error: Coordination server is not running on port ${SERVER_PORT:-9100}." >&2
  echo "Start the coordination server first: cd server && npm run dev" >&2
  exit 1
fi

# ── Compile dynamic agents ──────────────────────────────────────────────────
if [[ "$_CLI_NO_AGENT" != "true" ]]; then
  _team_flag=""
  [[ -n "$_CLI_TEAM" ]] && _team_flag="true"
  _compile_agents "$SCRIPT_DIR" "$AGENT_TYPE" "$_team_flag"
fi
export AGENTS_PATH

# ── Team mode — delegate to scripts/launch-team.sh ──────────────────────────
if [[ -n "$_CLI_TEAM" ]]; then
  export _CLI_TEAM _CLI_BRIEF PROJECT_ID SERVER_PORT SCRIPT_DIR
  export BARE_REPO_PATH UE_ENGINE_PATH CLAUDE_CREDENTIALS_PATH AGENTS_PATH
  export MAX_TURNS LOG_VERBOSITY
  exec "$SCRIPT_DIR/scripts/launch-team.sh"
fi

# ── Agent collision guard ───────────────────────────────────────────────────
if [[ "$_CLI_NO_AGENT" != "true" ]]; then
  _agent_status=$(curl -sf "http://localhost:${SERVER_PORT}/agents/${AGENT_NAME}" \
      -H "X-Project-Id: ${PROJECT_ID}" 2>/dev/null | jq -r '.status // empty' 2>/dev/null || true)
  if [[ "$_agent_status" == "active" ]]; then
    echo "Error: agent '${AGENT_NAME}' is already active for project '${PROJECT_ID}'." >&2
    echo "Use a different --agent-name, or stop the existing container first." >&2
    exit 1
  fi
fi

# ── Stop existing container ─────────────────────────────────────────────────
(cd "$SCRIPT_DIR/container" && \
  "${COMPOSE_CMD[@]}" --project-name "$(_compose_project_name "$PROJECT_ID" "$AGENT_NAME")" down 2>/dev/null) || true

# ── Branch setup ─────────────────────────────────────────────────────────────
_validate_bare_repo

if ! [ "$_CLI_PARALLEL" -ge 1 ] 2>/dev/null; then
  _setup_branch "$AGENT_BRANCH" "$_CLI_FRESH"
fi

# ── Build compose file list ─────────────────────────────────────────────────
_compose_dir="$SCRIPT_DIR/container"
_compose_files=("docker-compose.template.yml")
if [[ -n "${UE_ENGINE_PATH:-}" ]]; then
  _compose_files+=("docker-compose.engine.yml")
fi

# ── Export vars for docker-compose ───────────────────────────────────────────
export HOOK_BUILD_INTERCEPT HOOK_CPP_LINT HOOK_JS_LINT
export AGENT_NAME WORK_BRANCH AGENT_TYPE CLAUDE_EFFORT MAX_TURNS LOG_VERBOSITY PROJECT_ID
export BARE_REPO_PATH UE_ENGINE_PATH PROJECT_PATH LOGS_PATH
export WORKER_MODE WORKER_POLL_INTERVAL WORKER_SINGLE_TASK
export AGENT_MODE="${AGENT_MODE:-single}"
export SERVER_PORT="${SERVER_PORT:-9100}"
export DIRECT_PROMPT="${_CLI_PROMPT:-}"

# ── Launch ───────────────────────────────────────────────────────────────────
if [ "$_CLI_PARALLEL" -ge 1 ] 2>/dev/null; then
  echo "=== Launching $_CLI_PARALLEL parallel agents ==="
  for i in $(seq 1 "$_CLI_PARALLEL"); do
    _AGENT="agent-${i}"
    _BRANCH="docker/${PROJECT_ID}/${_AGENT}"
    _setup_branch "$_BRANCH" "$_CLI_FRESH"
    _launch_container "$_AGENT" "$_compose_dir" "${_compose_files[@]}" -- \
      AGENT_NAME="$_AGENT" WORK_BRANCH="$_BRANCH" PROJECT_ID="$PROJECT_ID" \
      BARE_REPO_PATH="$BARE_REPO_PATH" AGENTS_PATH="$AGENTS_PATH" \
      HOOK_BUILD_INTERCEPT="$HOOK_BUILD_INTERCEPT" HOOK_CPP_LINT="$HOOK_CPP_LINT" HOOK_JS_LINT="$HOOK_JS_LINT" \
      WORKER_MODE=true WORKER_SINGLE_TASK=false
    echo "  Launched $_AGENT on branch $_BRANCH"
  done
  _print_resolved_config
  echo "Monitor: ./status.sh --follow    Stop: ./stop.sh    Drain: ./stop.sh --drain"
else
  _launch_container "$AGENT_NAME" "$_compose_dir" "${_compose_files[@]}"
  _print_resolved_config
  echo "Monitor: ./status.sh --follow"
  echo "Logs:    ${COMPOSE_CMD[*]} --project-name $(_compose_project_name "$PROJECT_ID" "$AGENT_NAME") -f $_compose_dir/docker-compose.template.yml logs -f"
  echo "Stop:    ${COMPOSE_CMD[*]} --project-name \"$(_compose_project_name "$PROJECT_ID" "$AGENT_NAME")\" down"
fi
