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
  --fresh             Delete and re-clone the bare repo (clean start)
  --dry-run           Print resolved configuration and exit without launching
  --help              Show this help message and exit

Branch is determined automatically from the agent's staging worktree.

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
BARE_REPO_ROOT="$(jq -r '.server.bareRepoRoot // empty' "$_cfg")"
TASKS_PATH="$(jq -r '.tasks.path // empty' "$_cfg")"
STAGING_WORKTREE="$(jq -r '.server.stagingWorktreePath // empty' "$_cfg")"
STAGING_WORKTREE_ROOT="$(jq -r '.server.stagingWorktreeRoot // empty' "$_cfg")"
SERVER_PORT="$(jq -r '.server.port // 9100' "$_cfg")"
BUILD_SCRIPT_NAME="$(jq -r '.build.scriptPath // "build.py"' "$_cfg" | xargs basename)"
TEST_SCRIPT_NAME="$(jq -r '.build.testScriptPath // "run_tests.py"' "$_cfg" | xargs basename)"
DEFAULT_TEST_FILTERS="$(jq -r '.build.defaultTestFilters // [] | join(" ")' "$_cfg")"

# CLONE_SOURCE and BARE_REPO_PATH are resolved after AGENT_NAME is known (below)

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

# ── Resolve per-agent paths (staging worktree + bare repo) ──────────────────
# If root directories are configured, derive per-agent paths from AGENT_NAME.
# Otherwise fall back to the single-path values (V2 backwards-compatible).
if [[ -n "$STAGING_WORKTREE_ROOT" ]]; then
  STAGING_WORKTREE="${STAGING_WORKTREE_ROOT}/${AGENT_NAME}"
  if [[ ! -d "$STAGING_WORKTREE" ]]; then
    echo "Error: Staging worktree for $AGENT_NAME not found at $STAGING_WORKTREE" >&2
    echo "Create it first: git clone --branch <branch> <source> \"$STAGING_WORKTREE\"" >&2
    exit 1
  fi
fi
CLONE_SOURCE="${STAGING_WORKTREE:-${PROJECT_PATH}}"

# Derive WORK_BRANCH from the staging worktree's current branch.
# Falls back to WORK_BRANCH from .env or "main" for legacy single-path mode.
if [[ -n "$STAGING_WORKTREE_ROOT" ]]; then
  WORK_BRANCH="$(git -C "$CLONE_SOURCE" branch --show-current 2>/dev/null)" || true
  if [[ -z "$WORK_BRANCH" ]]; then
    echo "Error: Could not determine branch from staging worktree at $CLONE_SOURCE" >&2
    exit 1
  fi
else
  WORK_BRANCH="${WORK_BRANCH:-main}"
fi

if [[ -n "$BARE_REPO_ROOT" ]]; then
  BARE_REPO_PATH="${BARE_REPO_ROOT}/${AGENT_NAME}.git"
fi

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

if [ "$_CLI_PARALLEL" -ge 1 ] 2>/dev/null && [[ -z "${STAGING_WORKTREE_ROOT:-}" ]]; then
  _errors+=("--parallel requires server.stagingWorktreeRoot to be set in scaffold.config.json")
fi
if [ "$_CLI_PARALLEL" -ge 1 ] 2>/dev/null && [[ -z "${BARE_REPO_ROOT:-}" ]]; then
  _errors+=("--parallel requires server.bareRepoRoot to be set in scaffold.config.json")
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
  echo "  WORK_BRANCH:      $WORK_BRANCH"
  echo "  AGENT_TYPE:       $AGENT_TYPE"
  echo "  MAX_TURNS:        $MAX_TURNS"
  echo "  CLONE_SOURCE:     $CLONE_SOURCE"
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

# ── Bare repo setup ─────────────────────────────────────────────────────────
if [ "$_CLI_FRESH" = "true" ] && [ -d "$BARE_REPO_PATH" ]; then
    echo "Removing existing bare repo (--fresh)..."
    rm -rf "$BARE_REPO_PATH"
fi

if [[ ! -d "$BARE_REPO_PATH" ]]; then
  echo "Creating bare repo from $CLONE_SOURCE ..."
  git clone --bare "$CLONE_SOURCE" "$BARE_REPO_PATH"
else
  # Ensure the staging worktree has the bare repo as a remote ("exchange")
  _existing_remote=$(git -C "$CLONE_SOURCE" remote get-url exchange 2>/dev/null || true)
  if [[ -z "$_existing_remote" ]]; then
    echo "Adding bare repo as 'exchange' remote on staging worktree..."
    git -C "$CLONE_SOURCE" remote add exchange "$BARE_REPO_PATH"
  elif [[ "$_existing_remote" != "$BARE_REPO_PATH" ]]; then
    git -C "$CLONE_SOURCE" remote set-url exchange "$BARE_REPO_PATH"
  fi

  # Fetch from bare repo first — picks up any work the previous container left behind
  echo "Syncing staging worktree from bare repo..."
  if git -C "$CLONE_SOURCE" fetch exchange "$WORK_BRANCH" 2>/dev/null; then
    # If the bare repo's branch is ahead, fast-forward the staging worktree
    _local=$(git -C "$CLONE_SOURCE" rev-parse HEAD 2>/dev/null)
    _remote=$(git -C "$CLONE_SOURCE" rev-parse FETCH_HEAD 2>/dev/null)
    if [[ "$_local" != "$_remote" ]]; then
      if git -C "$CLONE_SOURCE" merge-base --is-ancestor "$_local" "$_remote" 2>/dev/null; then
        echo "Fast-forwarding staging worktree to bare repo's latest..."
        git -C "$CLONE_SOURCE" reset --hard FETCH_HEAD
      else
        echo "Warning: staging worktree and bare repo have diverged. Pushing staging state."
      fi
    fi
  fi

  # Push staging worktree state to bare repo (ensures any local staging changes are included)
  echo "Updating bare repo from staging worktree..."
  git -C "$CLONE_SOURCE" push "$BARE_REPO_PATH" "HEAD:refs/heads/${WORK_BRANCH}" --force 2>/dev/null || true
fi

# Ensure target branch exists in the bare repo
if ! git -C "$BARE_REPO_PATH" rev-parse --verify "$WORK_BRANCH" &>/dev/null; then
  echo "Branch '$WORK_BRANCH' does not exist in bare repo. Creating from default branch..."
  _default_branch=$(git -C "$BARE_REPO_PATH" symbolic-ref HEAD 2>/dev/null | sed 's|refs/heads/||')
  git -C "$BARE_REPO_PATH" branch "$WORK_BRANCH" "$_default_branch"
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
  BASE_BRANCH="$WORK_BRANCH"

  for i in $(seq 1 "$_CLI_PARALLEL"); do
    _AGENT="agent-${i}"
    _BRANCH="${BASE_BRANCH}-${i}"
    _STAGING="${STAGING_WORKTREE_ROOT}/${_AGENT}"
    _BARE="${BARE_REPO_ROOT}/${_AGENT}.git"

    # Validate staging worktree exists
    if [[ ! -d "$_STAGING" ]]; then
      echo "Error: Staging worktree for $_AGENT not found at $_STAGING" >&2
      exit 1
    fi

    # Create bare repo if needed
    if [[ ! -d "$_BARE" ]]; then
      git clone --bare "$_STAGING" "$_BARE"
    fi

    # Fork branch
    git -C "$_BARE" branch "$_BRANCH" "$BASE_BRANCH" 2>/dev/null || \
      git -C "$_BARE" branch -f "$_BRANCH" "$BASE_BRANCH"

    # Launch container
    (cd "$SCRIPT_DIR/container" && \
      AGENT_NAME="$_AGENT" \
      WORK_BRANCH="$_BRANCH" \
      WORKER_MODE=true \
      WORKER_SINGLE_TASK=false \
      AGENT_MODE=pump \
      $COMPOSE_CMD --project-name "claude-${_AGENT}" up --build --detach)

    echo "  Launched $_AGENT on branch $_BRANCH"
  done

  echo ""
  echo "=== $_CLI_PARALLEL Agents Launched ==="
  echo "  Base branch: $BASE_BRANCH"
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
