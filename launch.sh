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
  --verbosity LEVEL   Message board verbosity: quiet, normal, verbose (default: normal)
  --worker            Run in task-queue worker mode (no plan file needed)
  --pump              Run in pump mode (multi-task worker with claim-next)
  --parallel N        Launch N parallel pump agents (implies --pump)
  --fresh             Reset agent branch to docker/current-root HEAD (clean start)
  --dry-run           Print resolved configuration and exit without launching
  --help              Show this help message and exit

Branch is docker/{agent-name}, forked from docker/current-root.

Examples:
  ./launch.sh --plan plans/add-inventory.md
  ./launch.sh --agent-name agent-2 --worker
  ./launch.sh --worker --agent-name worker-1
  ./launch.sh --pump --agent-name pump-1
  ./launch.sh --verbosity verbose --plan plans/tricky-refactor.md
  ./launch.sh --parallel 3
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
UE_ENGINE_PATH="$(jq -r '.engine.path // empty' "$_cfg")"
PROJECT_PATH="$(jq -r '.project.path // empty' "$_cfg")"
BARE_REPO_PATH="$(jq -r '.server.bareRepoPath // empty' "$_cfg")"
TASKS_PATH="$(jq -r '.tasks.path // empty' "$_cfg")"
SERVER_PORT="$(jq -r '.server.port // 9100' "$_cfg")"
BUILD_SCRIPT_NAME="$(jq -r '.build.scriptPath // "build.py"' "$_cfg" | xargs basename)"
TEST_SCRIPT_NAME="$(jq -r '.build.testScriptPath // "run_tests.py"' "$_cfg" | xargs basename)"
DEFAULT_TEST_FILTERS="$(jq -r '.build.defaultTestFilters // [] | join(" ")' "$_cfg")"

# ── Apply CLI overrides ─────────────────────────────────────────────────────
AGENT_NAME="${_CLI_AGENT_NAME:-${AGENT_NAME:-agent-1}}"
AGENT_TYPE="${_CLI_AGENT_TYPE:-${AGENT_TYPE:-container-orchestrator}}"
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
if [[ -z "${UE_ENGINE_PATH:-}" ]]; then
  _errors+=("UE_ENGINE_PATH is not set. Set it in scaffold.config.json.")
fi
if [[ -z "${TASKS_PATH:-}" ]]; then
  _errors+=("TASKS_PATH is not set. Set it in scaffold.config.json.")
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

# ── Dry run ──────────────────────────────────────────────────────────────────
if [[ "$_CLI_DRY_RUN" == true ]]; then
  echo ""
  echo "=== Dry Run — Resolved Configuration ==="
  echo "  AGENT_NAME:       $AGENT_NAME"
  echo "  AGENT_BRANCH:     $AGENT_BRANCH"
  echo "  ROOT_BRANCH:      $ROOT_BRANCH"
  echo "  WORK_BRANCH:      $WORK_BRANCH"
  echo "  AGENT_TYPE:       $AGENT_TYPE"
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

# ── Export vars for docker-compose ───────────────────────────────────────────
export AGENT_NAME WORK_BRANCH AGENT_TYPE MAX_TURNS LOG_VERBOSITY
export BARE_REPO_PATH UE_ENGINE_PATH TASKS_PATH PROJECT_PATH
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
      BARE_REPO_PATH="$BARE_REPO_PATH" \
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
