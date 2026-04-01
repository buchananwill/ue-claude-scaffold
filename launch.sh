#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v jq &>/dev/null; then
    echo "Error: jq is required but not found." >&2
    echo "Install it: winget install jqlang.jq (Windows) or apt-get install jq (Linux)" >&2
    exit 1
fi

# ── Usage ────────────────────────────────────────────────────────────────────
usage() {
  cat <<'USAGE'
Usage: ./launch.sh [OPTIONS]

Launch a containerized Claude Code agent against your Unreal Engine project.

Options:
  --agent-name NAME   Agent identifier (default: from .env or "agent-1")
  --plan PATH         Path to a plan markdown file (copied to TASKS_PATH/prompt.md)
  --agent-type TYPE   Agent type (default: from .env or "container-orchestrator")
  --project ID        Project identifier for multi-project configs (default: "default")
  --verbosity LEVEL   Message board verbosity: quiet, normal, verbose (default: normal)
  --worker            Run in task-queue worker mode (no plan file needed)
  --pump              Run in pump mode (multi-task worker with claim-next)
  --parallel N        Launch N parallel pump agents (implies --pump)
  --fresh             Reset agent branch to docker/current-root HEAD (clean start)
  --team TEAM_ID      Launch a design team (reads teams/<TEAM_ID>.json)
  --brief PATH        Repo-relative path to a brief file (required with --team)
  --dry-run           Print resolved configuration and exit without launching
  --hooks             Force all hooks enabled (build intercept + C++ lint)
  --no-hooks          Force all hooks disabled
  --help              Show this help message and exit

Branch is docker/{agent-name}, forked from docker/current-root.

Examples:
  ./launch.sh --plan plans/add-inventory.md
  ./launch.sh --agent-name agent-2 --worker
  ./launch.sh --worker --agent-name worker-1
  ./launch.sh --pump --agent-name pump-1
  ./launch.sh --verbosity verbose --plan plans/tricky-refactor.md
  ./launch.sh --parallel 3
  ./launch.sh --team design-team-1 --brief Notes/docker-claude/briefs/inventory.md
  ./launch.sh --dry-run
USAGE
}

# ── Parse CLI flags ──────────────────────────────────────────────────────────
_CLI_AGENT_NAME=""
_CLI_PLAN=""
_CLI_AGENT_TYPE=""
_CLI_VERBOSITY=""
_CLI_DRY_RUN=false
_CLI_WORKER=false
_CLI_PUMP=false
_CLI_FRESH=false
_CLI_PARALLEL=0
_CLI_PROJECT=""
_CLI_TEAM=""
_CLI_BRIEF=""
_CLI_HOOK_BUILD=""
_CLI_HOOK_LINT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-name)
      _CLI_AGENT_NAME="$2"; shift 2 ;;
    --plan)
      _CLI_PLAN="$2"; shift 2 ;;
    --agent-type)
      _CLI_AGENT_TYPE="$2"; shift 2 ;;
    --verbosity)
      _CLI_VERBOSITY="$2"; shift 2 ;;
    --worker)
      _CLI_WORKER=true; shift ;;
    --pump)
      _CLI_PUMP=true; shift ;;
    --parallel)
      _CLI_PARALLEL="$2"; shift 2 ;;
    --fresh)
      _CLI_FRESH=true; shift ;;
    --project)
      _CLI_PROJECT="$2"; shift 2 ;;
    --team)
      _CLI_TEAM="$2"; shift 2 ;;
    --brief)
      _CLI_BRIEF="$2"; shift 2 ;;
    --hooks)
      _CLI_HOOK_BUILD="true"; _CLI_HOOK_LINT="true"; shift ;;
    --no-hooks)
      _CLI_HOOK_BUILD="false"; _CLI_HOOK_LINT="false"; shift ;;
    --dry-run)
      _CLI_DRY_RUN=true; shift ;;
    --help)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1 ;;
  esac
done

# ── Load .env (secrets and per-launch params only) ────────────────────────────
if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
  echo "Error: .env not found at $SCRIPT_DIR/.env" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source "$SCRIPT_DIR/.env"
set +a

# ── Read structural config from scaffold.config.json ─────────────────────────
if [[ ! -f "$SCRIPT_DIR/scaffold.config.json" ]]; then
  echo "Error: scaffold.config.json not found at $SCRIPT_DIR/scaffold.config.json" >&2
  echo "Run ./setup.sh or copy scaffold.config.example.json and configure it." >&2
  exit 1
fi

_cfg="$SCRIPT_DIR/scaffold.config.json"

# ── Resolve PROJECT_ID ─────────────────────────────────────────────────────
PROJECT_ID="${_CLI_PROJECT:-default}"

# Validate PROJECT_ID format
if [[ ! "$PROJECT_ID" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Error: PROJECT_ID contains invalid characters: $PROJECT_ID" >&2
  echo "Only alphanumeric characters, hyphens, and underscores are allowed." >&2
  exit 1
fi

_validate_hook_values() {
    local label="$1"; shift
    for _hv in "$@"; do
        case "$_hv" in
            true|false|"") ;;
            *) echo "Error: hooks values in $label must be true or false, got '$_hv'" >&2; exit 1 ;;
        esac
    done
}

# ── Resolve project config from scaffold.config.json ───────────────────────
PROJECT_HOOK_BUILD=""
PROJECT_HOOK_LINT=""

if jq -e --arg id "$PROJECT_ID" '.projects[$id]' "$_cfg" >/dev/null 2>&1; then
  # Multi-project mode: read from projects map
  BARE_REPO_PATH=$(jq -r --arg id "$PROJECT_ID" '.projects[$id].bareRepoPath // empty' "$_cfg")
  PROJECT_PATH=$(jq -r --arg id "$PROJECT_ID" '.projects[$id].path // empty' "$_cfg")
  UE_ENGINE_PATH=$(jq -r --arg id "$PROJECT_ID" '.projects[$id].engine.path // empty' "$_cfg")
  TASKS_PATH=$(jq -r --arg id "$PROJECT_ID" '.projects[$id].tasksPath // empty' "$_cfg")
  SERVER_PORT=$(jq -r --arg id "$PROJECT_ID" '.projects[$id].serverPort // .server.port // 9100' "$_cfg")
  BUILD_SCRIPT_NAME=$(jq -r --arg id "$PROJECT_ID" '.projects[$id].build.scriptPath // .build.scriptPath // "build.py"' "$_cfg" | xargs basename)
  TEST_SCRIPT_NAME=$(jq -r --arg id "$PROJECT_ID" '.projects[$id].build.testScriptPath // .build.testScriptPath // "run_tests.py"' "$_cfg" | xargs basename)
  DEFAULT_TEST_FILTERS=$(jq -r --arg id "$PROJECT_ID" '.projects[$id].build.defaultTestFilters // .build.defaultTestFilters // [] | if type == "array" then join(" ") else . end' "$_cfg")
  LOGS_PATH=$(jq -r --arg id "$PROJECT_ID" '.projects[$id].logsPath // empty' "$_cfg")
  PROJECT_HOOK_BUILD=$(jq -r --arg id "$PROJECT_ID" '.projects[$id].hooks.buildIntercept // empty' "$_cfg")
  PROJECT_HOOK_LINT=$(jq -r --arg id "$PROJECT_ID" '.projects[$id].hooks.cppLint // empty' "$_cfg")
elif [[ "$PROJECT_ID" == "default" ]]; then
  # Legacy mode: read from top-level fields (existing code)
  UE_ENGINE_PATH="$(jq -r '.engine.path // empty' "$_cfg")"
  PROJECT_PATH="$(jq -r '.project.path // empty' "$_cfg")"
  BARE_REPO_PATH="$(jq -r '.server.bareRepoPath // empty' "$_cfg")"
  TASKS_PATH="$(jq -r '.tasks.path // empty' "$_cfg")"
  SERVER_PORT="$(jq -r '.server.port // 9100' "$_cfg")"
  BUILD_SCRIPT_NAME="$(jq -r '.build.scriptPath // "build.py"' "$_cfg" | xargs basename)"
  TEST_SCRIPT_NAME="$(jq -r '.build.testScriptPath // "run_tests.py"' "$_cfg" | xargs basename)"
  DEFAULT_TEST_FILTERS="$(jq -r '.build.defaultTestFilters // [] | join(" ")' "$_cfg")"
  LOGS_PATH="$(jq -r '.logs.path // empty' "$_cfg")"
  PROJECT_HOOK_BUILD=$(jq -r '.hooks.buildIntercept // empty' "$_cfg")
  PROJECT_HOOK_LINT=$(jq -r '.hooks.cppLint // empty' "$_cfg")
else
  # --project was specified but ID not found in projects map
  _available=$(jq -r '.projects // {} | keys | join(", ")' "$_cfg")
  echo "Error: Project '$PROJECT_ID' not found in scaffold.config.json." >&2
  if [[ -n "$_available" ]]; then
    echo "Available projects: $_available" >&2
  else
    echo "No projects defined. Add a 'projects' map to scaffold.config.json or omit --project." >&2
  fi
  exit 1
fi

# Validate project-level hook values from config
_validate_hook_values "scaffold.config.json" "$PROJECT_HOOK_BUILD" "$PROJECT_HOOK_LINT"

if [ -z "$LOGS_PATH" ]; then
    LOGS_PATH="$SCRIPT_DIR/logs"
fi
mkdir -p "$LOGS_PATH"

export BARE_REPO_PATH UE_ENGINE_PATH TASKS_PATH PROJECT_PATH CLAUDE_CREDENTIALS_PATH SERVER_PORT LOGS_PATH PROJECT_ID

# ── Apply CLI overrides ─────────────────────────────────────────────────────
AGENT_NAME="${_CLI_AGENT_NAME:-${AGENT_NAME:-agent-1}}"
AGENT_TYPE="${_CLI_AGENT_TYPE:-${AGENT_TYPE:-container-orchestrator}}"

# ── Validate AGENT_NAME and AGENT_TYPE (prevent path traversal) ────────────
if [[ ! "$AGENT_NAME" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Error: AGENT_NAME contains invalid characters: $AGENT_NAME" >&2
  echo "Only alphanumeric characters, hyphens, and underscores are allowed." >&2
  exit 1
fi
if [[ ! "$AGENT_TYPE" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Error: AGENT_TYPE contains invalid characters: $AGENT_TYPE" >&2
  echo "Only alphanumeric characters, hyphens, and underscores are allowed." >&2
  exit 1
fi
MAX_TURNS="${MAX_TURNS:-200}"
PLAN_PATH="${_CLI_PLAN}"
# --parallel implies pump mode
if [ "$_CLI_PARALLEL" -ge 1 ] 2>/dev/null; then
    _CLI_PUMP=true
fi

if [ "$_CLI_PUMP" = "true" ]; then
    WORKER_MODE=true
    WORKER_SINGLE_TASK=false
    AGENT_MODE=pump
elif [ "$_CLI_WORKER" = "true" ]; then
    WORKER_MODE=true
else
    WORKER_MODE="${WORKER_MODE:-false}"
fi
AGENT_MODE="${AGENT_MODE:-single}"
WORKER_POLL_INTERVAL="${WORKER_POLL_INTERVAL:-30}"
WORKER_SINGLE_TASK="${WORKER_SINGLE_TASK:-true}"
LOG_VERBOSITY="${_CLI_VERBOSITY:-${LOG_VERBOSITY:-normal}}"

# ── Compute branch names ─────────────────────────────────────────────────────
AGENT_BRANCH="docker/${AGENT_NAME}"
ROOT_BRANCH="${ROOT_BRANCH:-docker/current-root}"
WORK_BRANCH="$AGENT_BRANCH"

# Validate verbosity
case "$LOG_VERBOSITY" in
  quiet|normal|verbose) ;;
  *)
    echo "Error: --verbosity must be quiet, normal, or verbose (got '$LOG_VERBOSITY')" >&2
    exit 1 ;;
esac

# ── Resolve plan path to absolute ────────────────────────────────────────────
if [[ -n "$PLAN_PATH" ]]; then
  if [[ ! -f "$PLAN_PATH" ]]; then
    echo "Error: Plan file not found: $PLAN_PATH" >&2
    exit 1
  fi
  PLAN_PATH="$(cd "$(dirname "$PLAN_PATH")" && pwd)/$(basename "$PLAN_PATH")"
fi

# ── Validate required vars ───────────────────────────────────────────────────
_errors=()
if [[ -z "${BARE_REPO_PATH:-}" ]]; then
  _errors+=("BARE_REPO_PATH is not set. Set it in scaffold.config.json.")
fi
# UE_ENGINE_PATH is only required when the project declares an engine config
if [[ -z "${UE_ENGINE_PATH:-}" ]]; then
  _has_engine=false
  if jq -e --arg id "$PROJECT_ID" '.projects[$id].engine' "$_cfg" >/dev/null 2>&1; then
    _has_engine=true
  elif [[ "$PROJECT_ID" == "default" ]] && jq -e '.engine.path // empty | select(. != "")' "$_cfg" >/dev/null 2>&1; then
    _has_engine=true
  fi
  if [[ "$_has_engine" == true ]]; then
    _errors+=("UE_ENGINE_PATH is not set. Set engine.path in scaffold.config.json.")
  fi
fi
# TASKS_PATH is required for plan mode and worker mode
if [[ -z "${TASKS_PATH:-}" ]]; then
  if [[ "$WORKER_MODE" == "true" ]]; then
    _errors+=("TASKS_PATH is not set. Set tasksPath in scaffold.config.json (required for worker mode).")
  elif [[ -n "$PLAN_PATH" ]]; then
    _errors+=("TASKS_PATH is not set. Set tasksPath in scaffold.config.json (required when using --plan).")
  fi
fi

if [[ ${#_errors[@]} -gt 0 ]]; then
  echo "Configuration errors:" >&2
  for err in "${_errors[@]}"; do
    echo "  - $err" >&2
  done
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

# ── Hook resolution ─────────────────────────────────────────────────────────
_resolve_hook_value() {
    local result="$1"   # system default
    [ -n "$2" ] && result="$2"   # project override
    [ -n "$3" ] && result="$3"   # team override
    [ -n "$4" ] && result="$4"   # member override
    [ -n "$5" ] && result="$5"   # CLI override
    echo "$result"
}

resolve_hooks() {
    local member_json="${1:-}"

    # System default: buildIntercept is true if project has a build script
    local sys_build="false"
    local _has_build_script=""
    if jq -e --arg id "$PROJECT_ID" \
        '(.projects[$id].build.scriptPath // .build.scriptPath // empty) | select(. != "")' \
        "$_cfg" >/dev/null 2>&1; then
        _has_build_script="true"
    fi
    [ "$_has_build_script" = "true" ] && sys_build="true"
    local sys_lint="false"

    # Team-level overrides (only in team launch mode)
    local team_build="" team_lint=""
    if [ -n "${TEAM_DEF:-}" ] && [ -f "${TEAM_DEF:-}" ]; then
        team_build=$(jq -r '.hooks.buildIntercept // empty' "$TEAM_DEF")
        team_lint=$(jq -r '.hooks.cppLint // empty' "$TEAM_DEF")
    fi

    # Validate team hook values
    _validate_hook_values "team definition" "$team_build" "$team_lint"

    # Per-member overrides
    local member_build="" member_lint=""
    if [ -n "$member_json" ]; then
        member_build=$(echo "$member_json" | jq -r '.hooks.buildIntercept // empty')
        member_lint=$(echo "$member_json" | jq -r '.hooks.cppLint // empty')
    fi

    # Validate member hook values
    _validate_hook_values "member definition" "$member_build" "$member_lint"

    # Resolve cascade: system -> project -> team -> member -> CLI
    HOOK_BUILD_INTERCEPT=$(_resolve_hook_value "$sys_build" "$PROJECT_HOOK_BUILD" "$team_build" "$member_build" "${_CLI_HOOK_BUILD:-}")
    HOOK_CPP_LINT=$(_resolve_hook_value "$sys_lint" "$PROJECT_HOOK_LINT" "$team_lint" "$member_lint" "${_CLI_HOOK_LINT:-}")
}

# ── Dry run ──────────────────────────────────────────────────────────────────
if [[ "$_CLI_DRY_RUN" == true ]]; then
  if [[ -n "$_CLI_TEAM" ]]; then
    if [[ -f "$SCRIPT_DIR/teams/${_CLI_TEAM}.json" ]]; then
      TEAM_DEF="$SCRIPT_DIR/teams/${_CLI_TEAM}.json"
    else
      echo "Warning: Team file not found: $SCRIPT_DIR/teams/${_CLI_TEAM}.json (team hooks will not be applied)" >&2
    fi
  fi
  resolve_hooks ""
  echo ""
  echo "=== Dry Run — Resolved Configuration ==="
  echo "  AGENT_NAME:       $AGENT_NAME"
  echo "  AGENT_BRANCH:     $AGENT_BRANCH"
  echo "  ROOT_BRANCH:      $ROOT_BRANCH"
  echo "  WORK_BRANCH:      $WORK_BRANCH"
  echo "  AGENT_TYPE:       $AGENT_TYPE"
  echo "  PROJECT_ID:       $PROJECT_ID"
  if [[ -d "$SCRIPT_DIR/dynamic-agents" && -f "$SCRIPT_DIR/dynamic-agents/${AGENT_TYPE}.md" ]]; then
    echo "  AGENT_COMPILED:   yes (dynamic-agents/${AGENT_TYPE}.md)"
    # List other dynamic agents as potential sub-agents
    _sub_agents=()
    for _candidate in "$SCRIPT_DIR"/dynamic-agents/*.md; do
      _cname="$(basename "${_candidate%.md}")"
      if [[ "$_cname" != "$AGENT_TYPE" ]]; then
        _sub_agents+=("$_cname")
      fi
    done
    if [[ ${#_sub_agents[@]} -gt 0 ]]; then
      _sub_list=$(IFS=', '; echo "${_sub_agents[*]}")
      echo "  SUB_AGENT_CANDIDATES: $_sub_list"
    fi
  else
    echo "  AGENT_COMPILED:   no (static agents fallback)"
  fi
  echo "  MAX_TURNS:        $MAX_TURNS"
  echo "  BARE_REPO_PATH:   $BARE_REPO_PATH"
  echo "  UE_ENGINE_PATH:   $UE_ENGINE_PATH"
  echo "  TASKS_PATH:       $TASKS_PATH"
  echo "  SERVER_PORT:      ${SERVER_PORT:-9100}"
  echo "  PLAN_PATH:        ${PLAN_PATH:-<none>}"
  echo "  WORKER_MODE:      $WORKER_MODE"
  echo "  WORKER_POLL_INT:  $WORKER_POLL_INTERVAL"
  echo "  WORKER_SINGLE:    $WORKER_SINGLE_TASK"
  echo "  AGENT_MODE:       $AGENT_MODE"
  echo "  LOG_VERBOSITY:    $LOG_VERBOSITY"
  echo "  PARALLEL:         $_CLI_PARALLEL"
  echo "  FRESH:            $_CLI_FRESH"
  echo "  HOOKS:"
  echo "    buildIntercept: $HOOK_BUILD_INTERCEPT"
  echo "    cppLint:        $HOOK_CPP_LINT"
  if [ "$_CLI_PARALLEL" -ge 1 ] 2>/dev/null; then
    echo ""
    echo "Parallel agent branches:"
    for i in $(seq 1 "$_CLI_PARALLEL"); do
      echo "  agent-${i} → docker/agent-${i}"
    done
  fi
  echo ""
  exit 0
fi

# ── Compile dynamic agents ─────────────────────────────────────────────────
# Compile agents before team-mode/launch checks because team mode exits early
# and needs AGENTS_PATH. The rm -rf of .compiled-agents/ may affect bind-mounts
# of already-running containers; this is an accepted tradeoff (same as any build
# artifact rebuild).
COMPILED_AGENTS_DIR="$SCRIPT_DIR/.compiled-agents"
rm -rf "$COMPILED_AGENTS_DIR"
mkdir -p "$COMPILED_AGENTS_DIR"

if [[ ! -f "$SCRIPT_DIR/scripts/compile-agent.py" ]]; then
  echo "Error: compile-agent.py not found at $SCRIPT_DIR/scripts/" >&2
  exit 1
fi

if [[ -d "$SCRIPT_DIR/dynamic-agents" && -f "$SCRIPT_DIR/dynamic-agents/${AGENT_TYPE}.md" ]]; then
  echo "Compiling dynamic agent: ${AGENT_TYPE}..."
  if ! python "$SCRIPT_DIR/scripts/compile-agent.py" \
    "$SCRIPT_DIR/dynamic-agents/${AGENT_TYPE}.md" \
    -o "$COMPILED_AGENTS_DIR" \
    --recursive; then
    echo "Error: Agent compilation failed for '${AGENT_TYPE}'. See above for details." >&2
    exit 1
  fi
else
  # Fallback: copy static agents directory (legacy behaviour)
  if [[ -d "$SCRIPT_DIR/agents" ]]; then
    cp "$SCRIPT_DIR/agents/"*.md "$COMPILED_AGENTS_DIR/" 2>/dev/null || true
  fi
  # Warn if no agent files ended up in the output directory
  if ! ls "$COMPILED_AGENTS_DIR"/*.md &>/dev/null; then
    echo "Warning: No .md agent files found in compiled agents directory." >&2
    echo "  The container may still work if agents are provided from another source." >&2
  fi
fi

export AGENTS_PATH="$COMPILED_AGENTS_DIR"

# ── Team mode ───────────────────────────────────────────────────────────────
if [[ -n "$_CLI_TEAM" ]]; then
  # Validate brief — must be a repo-relative path that exists on docker/current-root
  if [[ -z "$_CLI_BRIEF" ]]; then
    echo "Error: --brief is required when using --team" >&2
    exit 1
  fi
  if ! git -C "$BARE_REPO_PATH" cat-file -e "${ROOT_BRANCH}:${_CLI_BRIEF}" 2>/dev/null; then
    echo "Error: Brief not found on ${ROOT_BRANCH}: $_CLI_BRIEF" >&2
    echo "Commit the brief in the exterior repo and sync with POST /sync/plans first." >&2
    exit 1
  fi

  # Read team definition
  TEAM_DEF="$SCRIPT_DIR/teams/${_CLI_TEAM}.json"
  if [[ ! -f "$TEAM_DEF" ]]; then
    echo "Error: Team definition not found: $TEAM_DEF" >&2
    exit 1
  fi

  TEAM_ID=$(jq -r '.id' "$TEAM_DEF")
  TEAM_NAME=$(jq -r '.name' "$TEAM_DEF")
  echo "=== Launching Team: $TEAM_NAME ==="
  echo "  Team ID: $TEAM_ID"
  echo "  Brief:   $_CLI_BRIEF"
  echo ""

  # Register team and create room
  TEAM_REG_RESPONSE=$(curl -sf -X POST "http://localhost:${SERVER_PORT}/teams" \
    -H "Content-Type: application/json" \
    -d @"$TEAM_DEF" 2>/dev/null) || {
    echo "Error: Could not register team with coordination server" >&2
    exit 1
  }
  ROOM_ID=$(echo "$TEAM_REG_RESPONSE" | jq -r '.roomId // .room // empty')
  if [[ -z "$ROOM_ID" ]]; then
    echo "Error: No room ID returned from team registration" >&2
    exit 1
  fi
  echo "  Room:    $ROOM_ID"

  # Post brief path as first room message so agents know where to find it
  _BRIEF_JSON=$(mktemp)
  jq -n --arg path "$_CLI_BRIEF" '{content: ("Brief: `" + $path + "` -- read this file from your workspace to begin.")}' > "$_BRIEF_JSON"
  _BRIEF_POST_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:${SERVER_PORT}/rooms/${ROOM_ID}/messages" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Name: user" \
    -d @"$_BRIEF_JSON" 2>&1)
  rm -f "$_BRIEF_JSON"
  _BRIEF_POST_STATUS="${_BRIEF_POST_RESPONSE##*$'\n'}"
  if [[ "$_BRIEF_POST_STATUS" != "200" ]]; then
    echo "Error: Failed to post brief path to room (HTTP ${_BRIEF_POST_STATUS})." >&2
    echo "  Response: ${_BRIEF_POST_RESPONSE%$'\n'*}" >&2
    exit 1
  fi
  echo "  Brief path posted to room: $_CLI_BRIEF"
  echo ""

  # Launch members — discussion leader first, then others
  launch_team_member() {
    local _MEMBER_NAME _MEMBER_ROLE _MEMBER_TYPE _MEMBER_BRANCH _IS_LEADER
    _MEMBER_NAME=$(echo "$1" | jq -r '.agentName')
    _MEMBER_ROLE=$(echo "$1" | jq -r '.role')
    _MEMBER_TYPE=$(echo "$1" | jq -r '.agentType')
    if [[ "$_MEMBER_TYPE" != "$AGENT_TYPE" ]] && [[ ! -f "$COMPILED_AGENTS_DIR/${_MEMBER_TYPE}.md" ]]; then
      echo "Warning: Team member '$_MEMBER_NAME' uses agent type '$_MEMBER_TYPE' which was not compiled. Container may fall back to static agent definitions." >&2
    fi
    _IS_LEADER=$(echo "$1" | jq -r '.isLeader // false')
    _MEMBER_BRANCH="docker/${_MEMBER_NAME}"

    # Resolve hook configuration via cascade
    resolve_hooks "$1"

    # Set up branch — always reset to current-root HEAD for team launches
    _ROOT_SHA=$(git -C "$BARE_REPO_PATH" rev-parse "refs/heads/${ROOT_BRANCH}")
    git -C "$BARE_REPO_PATH" update-ref "refs/heads/${_MEMBER_BRANCH}" "$_ROOT_SHA"
    echo "  Branch ${_MEMBER_BRANCH} set to ${ROOT_BRANCH} HEAD"

    # Stop existing container if running
    (cd "$SCRIPT_DIR/container" && \
      $COMPOSE_CMD --project-name "claude-${_MEMBER_NAME}" down 2>/dev/null) || true

    # Launch container
    (cd "$SCRIPT_DIR/container" && \
      AGENT_NAME="$_MEMBER_NAME" \
      WORK_BRANCH="$_MEMBER_BRANCH" \
      AGENT_TYPE="$_MEMBER_TYPE" \
      PROJECT_ID="$PROJECT_ID" \
      CHAT_ROOM="$ROOM_ID" \
      TEAM_ROLE="$_MEMBER_ROLE" \
      BRIEF_PATH="$_CLI_BRIEF" \
      BARE_REPO_PATH="$BARE_REPO_PATH" \
      TASKS_PATH="$TASKS_PATH" \
      UE_ENGINE_PATH="$UE_ENGINE_PATH" \
      CLAUDE_CREDENTIALS_PATH="$CLAUDE_CREDENTIALS_PATH" \
      AGENTS_PATH="$AGENTS_PATH" \
      SERVER_PORT="$SERVER_PORT" \
      MAX_TURNS="$MAX_TURNS" \
      LOG_VERBOSITY="$LOG_VERBOSITY" \
      WORKER_MODE=false \
      HOOK_CPP_LINT="$HOOK_CPP_LINT" \
      $COMPOSE_CMD --project-name "claude-${_MEMBER_NAME}" up --build --detach)

    echo "  Launched $_MEMBER_NAME (role: $_MEMBER_ROLE, type: $_MEMBER_TYPE, hooks: build=$HOOK_BUILD_INTERCEPT lint=$HOOK_CPP_LINT)"
  }

  # Launch discussion leader first
  jq -c '.members[] | select(.isLeader == true)' "$TEAM_DEF" | while IFS= read -r member; do
    launch_team_member "$member"
  done

  echo "  Waiting 10s before launching other members..."
  sleep 10

  # Launch non-leader members
  jq -c '.members[] | select(.isLeader == false)' "$TEAM_DEF" | while IFS= read -r member; do
    launch_team_member "$member"
  done

  echo ""
  echo "=== Team Launched ==="
  echo "  Team:    $TEAM_NAME ($TEAM_ID)"
  echo "  Room:    $ROOM_ID"
  echo "  Members: $(jq -r '[.members[].agentName] | join(", ")' "$TEAM_DEF")"
  echo ""
  echo "Monitor progress:"
  echo "  ./status.sh --follow"
  echo ""
  echo "Stop team:"
  echo "  ./stop.sh --team $TEAM_ID"
  exit 0
fi

# ── Copy plan file to TASKS_PATH/prompt.md (skip in worker mode) ─────────────
if [[ "$WORKER_MODE" != "true" && -n "$PLAN_PATH" ]]; then
  if [[ -f "$TASKS_PATH/prompt.md" ]]; then
    echo "Warning: Overwriting existing $TASKS_PATH/prompt.md" >&2
  fi
  mkdir -p "$TASKS_PATH"
  cp "$PLAN_PATH" "$TASKS_PATH/prompt.md"
  echo "Copied plan to $TASKS_PATH/prompt.md"
fi

# ── Check coordination server ────────────────────────────────────────────────
if ! curl -sf "http://localhost:${SERVER_PORT:-9100}/health" >/dev/null 2>&1; then
  echo "Error: Coordination server is not running on port ${SERVER_PORT:-9100}." >&2
  echo "Start the coordination server first: cd server && npm run dev" >&2
  exit 1
fi

# ── Stop existing container if running ──────────────────────────────────────
(
  cd "$SCRIPT_DIR/container"
  $COMPOSE_CMD --project-name "claude-${AGENT_NAME}" down 2>/dev/null || true
)

# ── Branch setup in persistent bare repo ────────────────────────────────────

if [[ ! -d "$BARE_REPO_PATH" ]]; then
  echo "Error: Bare repo not found at $BARE_REPO_PATH" >&2
  echo "Run ./setup.sh to create it, or create it manually:" >&2
  echo "  git clone --bare <your-project> $BARE_REPO_PATH" >&2
  exit 1
fi

if ! git -C "$BARE_REPO_PATH" rev-parse --verify "refs/heads/${ROOT_BRANCH}" &>/dev/null; then
  echo "Error: Branch '${ROOT_BRANCH}' not found in bare repo." >&2
  echo "Push it from your project:" >&2
  echo "  git push $BARE_REPO_PATH HEAD:refs/heads/${ROOT_BRANCH}" >&2
  exit 1
fi

if ! [ "$_CLI_PARALLEL" -ge 1 ] 2>/dev/null; then
  # Single-agent branch setup
  if [ "$_CLI_FRESH" = "true" ]; then
    echo "Resetting ${AGENT_BRANCH} to ${ROOT_BRANCH} (--fresh)..."
    ROOT_SHA=$(git -C "$BARE_REPO_PATH" rev-parse "refs/heads/${ROOT_BRANCH}")
    git -C "$BARE_REPO_PATH" update-ref "refs/heads/${AGENT_BRANCH}" "$ROOT_SHA"
  else
    if ! git -C "$BARE_REPO_PATH" rev-parse --verify "refs/heads/${AGENT_BRANCH}" &>/dev/null; then
      echo "No existing branch ${AGENT_BRANCH}. Creating from ${ROOT_BRANCH}..."
      ROOT_SHA=$(git -C "$BARE_REPO_PATH" rev-parse "refs/heads/${ROOT_BRANCH}")
      git -C "$BARE_REPO_PATH" update-ref "refs/heads/${AGENT_BRANCH}" "$ROOT_SHA"
    else
      echo "Resuming from existing branch ${AGENT_BRANCH}."
    fi
  fi
fi

resolve_hooks ""

# ── Generate docker-compose.yml ─────────────────────────────────────────────
# Built dynamically so that optional volume mounts (UE engine, plugins) are
# only included when the project actually needs them.  This avoids host-OS
# portability issues (e.g. /dev/null fallback doesn't exist on Windows).

_COMPOSE_FILE="$SCRIPT_DIR/container/docker-compose.yml"

_generate_compose() {
  local _volumes=""
  _volumes="      # Required: bare repo for git operations
      - \${BARE_REPO_PATH:?Set BARE_REPO_PATH}:/repo.git
      # Required: task prompt and standing instructions
      - \${TASKS_PATH:?Set TASKS_PATH}:/task:ro
      # Host-side logs (persist after container shutdown for forensic review)
      - \${LOGS_PATH:-./logs}:/logs
      # Claude authentication (OAuth credentials file)
      - \${CLAUDE_CREDENTIALS_PATH:?Set CLAUDE_CREDENTIALS_PATH in .env}:/home/claude/.claude/.credentials.json:ro
      # Agent definitions (compiled by launch.sh)
      - \${AGENTS_PATH:-../agents}:/home/claude/.claude/agents:ro"

  # UE engine mount — only for projects that declare an engine path
  if [ -n "${UE_ENGINE_PATH:-}" ]; then
    _volumes="${_volumes}
      # UE engine (read-only)
      - \${UE_ENGINE_PATH}:/engine:ro"
  fi

  cat > "$_COMPOSE_FILE" <<COMPOSEOF
# Auto-generated by launch.sh — do not edit manually.
# Template: container/docker-compose.example.yml

services:
  claude-worker:
    build:
      context: .
    environment:
      - AGENT_NAME=\${AGENT_NAME:-agent-1}
      - WORK_BRANCH=\${WORK_BRANCH:-main}
      - AGENT_TYPE=\${AGENT_TYPE:-container-orchestrator}
      - MAX_TURNS=\${MAX_TURNS:-200}
      - SERVER_URL=http://host.docker.internal:\${SERVER_PORT:-9100}
      - TASK_PROMPT_FILE=/task/prompt.md
      - BUILD_SCRIPT_NAME=\${BUILD_SCRIPT_NAME:-build.py}
      - TEST_SCRIPT_NAME=\${TEST_SCRIPT_NAME:-run_tests.py}
      - DEFAULT_TEST_FILTERS=\${DEFAULT_TEST_FILTERS:-}
      - LOG_VERBOSITY=\${LOG_VERBOSITY:-normal}
      - WORKER_MODE=\${WORKER_MODE:-false}
      - WORKER_POLL_INTERVAL=\${WORKER_POLL_INTERVAL:-30}
      - WORKER_SINGLE_TASK=\${WORKER_SINGLE_TASK:-true}
      - HOOK_CPP_LINT=\${HOOK_CPP_LINT:-false}
      - PROJECT_ID=\${PROJECT_ID:-default}
      - CHAT_ROOM=\${CHAT_ROOM:-}
      - TEAM_ROLE=\${TEAM_ROLE:-}
      - BRIEF_PATH=\${BRIEF_PATH:-}
    volumes:
${_volumes}
    ports:
      - "8788:8788"
    extra_hosts:
      - "host.docker.internal:host-gateway"
COMPOSEOF
}

_generate_compose

# ── Export vars for docker-compose ───────────────────────────────────────────
export HOOK_CPP_LINT
export AGENT_NAME WORK_BRANCH AGENT_TYPE MAX_TURNS LOG_VERBOSITY PROJECT_ID
export BARE_REPO_PATH UE_ENGINE_PATH TASKS_PATH PROJECT_PATH LOGS_PATH
export WORKER_MODE WORKER_POLL_INTERVAL WORKER_SINGLE_TASK
export AGENT_MODE="${AGENT_MODE:-single}"
export SERVER_PORT="${SERVER_PORT:-9100}"

# ── Launch ───────────────────────────────────────────────────────────────────
if [ "$_CLI_PARALLEL" -ge 1 ] 2>/dev/null; then
  echo "=== Launching $_CLI_PARALLEL parallel agents ==="

  for i in $(seq 1 "$_CLI_PARALLEL"); do
    _AGENT="agent-${i}"
    _BRANCH="docker/${_AGENT}"

    if [ "$_CLI_FRESH" = "true" ]; then
      _ROOT_SHA=$(git -C "$BARE_REPO_PATH" rev-parse "refs/heads/${ROOT_BRANCH}")
      git -C "$BARE_REPO_PATH" update-ref "refs/heads/${_BRANCH}" "$_ROOT_SHA"
      echo "  Reset branch ${_BRANCH} to ${ROOT_BRANCH} (--fresh)"
    elif ! git -C "$BARE_REPO_PATH" rev-parse --verify "refs/heads/${_BRANCH}" &>/dev/null; then
      _ROOT_SHA=$(git -C "$BARE_REPO_PATH" rev-parse "refs/heads/${ROOT_BRANCH}")
      git -C "$BARE_REPO_PATH" update-ref "refs/heads/${_BRANCH}" "$_ROOT_SHA"
      echo "  Created branch ${_BRANCH} from ${ROOT_BRANCH}"
    else
      echo "  Resuming existing branch ${_BRANCH}"
    fi

    (cd "$SCRIPT_DIR/container" && \
      AGENT_NAME="$_AGENT" \
      WORK_BRANCH="$_BRANCH" \
      PROJECT_ID="$PROJECT_ID" \
      BARE_REPO_PATH="$BARE_REPO_PATH" \
      AGENTS_PATH="$AGENTS_PATH" \
      HOOK_CPP_LINT="$HOOK_CPP_LINT" \
      WORKER_MODE=true \
      WORKER_SINGLE_TASK=false \
      AGENT_MODE=pump \
      $COMPOSE_CMD --project-name "claude-${_AGENT}" up --build --detach)

    echo "  Launched $_AGENT on branch $_BRANCH"
  done

  echo ""
  echo "=== $_CLI_PARALLEL Agents Launched ==="
  echo "  Root branch: $ROOT_BRANCH"
  echo ""
  echo "Monitor progress:"
  echo "  ./status.sh --follow"
  echo ""
  echo "Stop all agents:"
  echo "  ./stop.sh"
  echo ""
  echo "Graceful drain:"
  echo "  ./stop.sh --drain"
else
  cd "$SCRIPT_DIR/container"
  if [ "$_CLI_FRESH" = "true" ]; then
      $COMPOSE_CMD --project-name "claude-${AGENT_NAME}" build --no-cache
  fi
  $COMPOSE_CMD --project-name "claude-${AGENT_NAME}" up --build --detach

  echo ""
  echo "=== Agent Launched ==="
  echo "  Agent:     $AGENT_NAME"
  echo "  Branch:    $WORK_BRANCH"
  echo "  Type:      $AGENT_TYPE"
  echo "  Verbosity: $LOG_VERBOSITY"
  echo ""
  echo "Monitor progress:"
  echo "  ./status.sh --follow"
  echo ""
  echo "View container logs:"
  echo "  docker compose --project-name claude-${AGENT_NAME} -f $SCRIPT_DIR/container/docker-compose.yml logs -f"
  echo ""
  echo "Stop agent:"
  echo "  $COMPOSE_CMD --project-name \"claude-${AGENT_NAME}\" down"
fi
