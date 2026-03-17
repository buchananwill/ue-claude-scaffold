#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Usage ────────────────────────────────────────────────────────────────────
usage() {
  cat <<'USAGE'
Usage: ./launch.sh [OPTIONS]

Launch a containerized Claude Code agent against your Unreal Engine project.

Options:
  --agent-name NAME   Agent identifier (default: from .env or "agent-1")
  --branch BRANCH     Git branch to work on (default: from .env or "main")
  --plan PATH         Path to a plan markdown file (copied to TASKS_PATH/prompt.md)
  --agent-type TYPE   Agent type (default: from .env or "container-orchestrator")
  --worker            Run in task-queue worker mode (no plan file needed)
  --dry-run           Print resolved configuration and exit without launching
  --help              Show this help message and exit

Examples:
  ./launch.sh --plan plans/add-inventory.md
  ./launch.sh --agent-name agent-2 --branch feature/ui --plan plans/ui-rework.md
  ./launch.sh --worker --agent-name worker-1
  ./launch.sh --dry-run
USAGE
}

# ── Parse CLI flags ──────────────────────────────────────────────────────────
_CLI_AGENT_NAME=""
_CLI_BRANCH=""
_CLI_PLAN=""
_CLI_AGENT_TYPE=""
_CLI_DRY_RUN=false
_CLI_WORKER=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-name)
      _CLI_AGENT_NAME="$2"; shift 2 ;;
    --branch)
      _CLI_BRANCH="$2"; shift 2 ;;
    --plan)
      _CLI_PLAN="$2"; shift 2 ;;
    --agent-type)
      _CLI_AGENT_TYPE="$2"; shift 2 ;;
    --worker)
      _CLI_WORKER=true; shift ;;
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

# ── Source .env ──────────────────────────────────────────────────────────────
if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
  echo "Error: .env file not found at $SCRIPT_DIR/.env" >&2
  echo "Run ./setup.sh or copy .env.example to .env and configure it." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "$SCRIPT_DIR/.env"
set +a

# ── Apply CLI overrides ─────────────────────────────────────────────────────
AGENT_NAME="${_CLI_AGENT_NAME:-${AGENT_NAME:-agent-1}}"
WORK_BRANCH="${_CLI_BRANCH:-${WORK_BRANCH:-main}}"
AGENT_TYPE="${_CLI_AGENT_TYPE:-${AGENT_TYPE:-container-orchestrator}}"
MAX_TURNS="${MAX_TURNS:-200}"
PLAN_PATH="${_CLI_PLAN}"
if [ "$_CLI_WORKER" = "true" ]; then
    WORKER_MODE=true
else
    WORKER_MODE="${WORKER_MODE:-false}"
fi
WORKER_POLL_INTERVAL="${WORKER_POLL_INTERVAL:-30}"
WORKER_SINGLE_TASK="${WORKER_SINGLE_TASK:-true}"

# ── Resolve plan path to absolute ────────────────────────────────────────────
if [[ -n "$PLAN_PATH" ]]; then
  if [[ ! -f "$PLAN_PATH" ]]; then
    echo "Error: Plan file not found: $PLAN_PATH" >&2
    exit 1
  fi
  PLAN_PATH="$(cd "$(dirname "$PLAN_PATH")" && pwd)/$(basename "$PLAN_PATH")"
fi

# ── Derive branch from plan filename if --plan given but --branch not ────────
if [[ -n "$PLAN_PATH" && -z "$_CLI_BRANCH" ]]; then
  _derived=$(basename "$PLAN_PATH" .md | tr '[:upper:]' '[:lower:]' | tr ' _' '-')
  WORK_BRANCH="feature/$_derived"
fi

# ── Validate required vars ───────────────────────────────────────────────────
_errors=()
if [[ -z "${BARE_REPO_PATH:-}" ]]; then
  _errors+=("BARE_REPO_PATH is not set. Set it in .env or scaffold.config.json.")
fi
if [[ -z "${UE_ENGINE_PATH:-}" ]]; then
  _errors+=("UE_ENGINE_PATH is not set. Set it in .env.")
fi
if [[ -z "${TASKS_PATH:-}" ]]; then
  _errors+=("TASKS_PATH is not set. Set it in .env.")
fi

if [[ ${#_errors[@]} -gt 0 ]]; then
  echo "Configuration errors:" >&2
  for err in "${_errors[@]}"; do
    echo "  - $err" >&2
  done
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
  echo "  PROJECT_PATH:     ${PROJECT_PATH:-<not set>}"
  echo "  BARE_REPO_PATH:   $BARE_REPO_PATH"
  echo "  UE_ENGINE_PATH:   $UE_ENGINE_PATH"
  echo "  TASKS_PATH:       $TASKS_PATH"
  echo "  SERVER_PORT:      ${SERVER_PORT:-9100}"
  echo "  PLAN_PATH:        ${PLAN_PATH:-<none>}"
  echo "  WORKER_MODE:      $WORKER_MODE"
  echo "  WORKER_POLL_INT:  $WORKER_POLL_INTERVAL"
  echo "  WORKER_SINGLE:    $WORKER_SINGLE_TASK"
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

# ── Check coordination server ────────────────────────────────────────────────
if ! curl -sf "http://localhost:${SERVER_PORT:-9100}/health" >/dev/null 2>&1; then
  echo "Error: Coordination server is not running on port ${SERVER_PORT:-9100}." >&2
  echo "Start the coordination server first: cd server && npm run dev" >&2
  exit 1
fi

# ── Bare repo setup ─────────────────────────────────────────────────────────
if [[ ! -d "$BARE_REPO_PATH" ]]; then
  echo "Creating bare repo at $BARE_REPO_PATH ..."
  git clone --bare "${PROJECT_PATH:?PROJECT_PATH is not set}" "$BARE_REPO_PATH"
else
  # Only push the current branch from the project, don't overwrite agent branches
  echo "Updating bare repo..."
  git -C "${PROJECT_PATH:?PROJECT_PATH is not set}" push "$BARE_REPO_PATH" "HEAD:refs/heads/${WORK_BRANCH}" --force 2>/dev/null || true
fi

# Ensure target branch exists in the bare repo
if ! git -C "$BARE_REPO_PATH" rev-parse --verify "$WORK_BRANCH" &>/dev/null; then
  echo "Branch '$WORK_BRANCH' does not exist in bare repo. Creating from default branch..."
  _default_branch=$(git -C "$BARE_REPO_PATH" symbolic-ref HEAD 2>/dev/null | sed 's|refs/heads/||')
  git -C "$BARE_REPO_PATH" branch "$WORK_BRANCH" "$_default_branch"
fi

# ── Export vars for docker-compose ───────────────────────────────────────────
export AGENT_NAME WORK_BRANCH AGENT_TYPE MAX_TURNS
export BARE_REPO_PATH UE_ENGINE_PATH TASKS_PATH PROJECT_PATH
export WORKER_MODE WORKER_POLL_INTERVAL WORKER_SINGLE_TASK
export SERVER_PORT="${SERVER_PORT:-9100}"

# ── Launch ───────────────────────────────────────────────────────────────────
cd "$SCRIPT_DIR/container"
$COMPOSE_CMD --project-name "claude-${AGENT_NAME}" up --build --detach

echo ""
echo "=== Agent Launched ==="
echo "  Agent:   $AGENT_NAME"
echo "  Branch:  $WORK_BRANCH"
echo "  Type:    $AGENT_TYPE"
echo ""
echo "Monitor progress:"
echo "  ./status.sh --follow"
echo ""
echo "View container logs:"
echo "  docker compose --project-name claude-${AGENT_NAME} -f $SCRIPT_DIR/container/docker-compose.yml logs -f"
echo ""
echo "Stop agent:"
echo "  $COMPOSE_CMD --project-name \"claude-${AGENT_NAME}\" down"
