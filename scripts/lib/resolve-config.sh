#!/bin/bash
# scripts/lib/resolve-config.sh -- Resolve project config from scaffold.config.json.
#
# Reads structural config from scaffold.config.json and sets global variables.
# Source this file; do not execute it directly.

# Guard against double-sourcing
[[ -n "${_LIB_RESOLVE_CONFIG_LOADED:-}" ]] && return 0
readonly _LIB_RESOLVE_CONFIG_LOADED=1

# shellcheck source=validators.sh
source "$(dirname "${BASH_SOURCE[0]}")/validators.sh"

# _validate_hook_values <label> <value...>
#   Validates that each value is "true", "false", or empty.
_validate_hook_values() {
  local label="$1"; shift
  for _hv in "$@"; do
    case "$_hv" in
      true|false|"") ;;
      *) echo "Error: hooks values in $label must be true or false, got '$_hv'" >&2; exit 1 ;;
    esac
  done
}

# _resolve_project_config <script_dir> <project_id>
#   Reads scaffold.config.json and sets the global config variables:
#     BARE_REPO_PATH, PROJECT_PATH, UE_ENGINE_PATH, SERVER_PORT,
#     BUILD_SCRIPT_NAME, TEST_SCRIPT_NAME, DEFAULT_TEST_FILTERS, LOGS_PATH,
#     PROJECT_HOOK_BUILD, PROJECT_HOOK_LINT, PROJECT_AGENT_TYPE, PROJECT_EFFORT, PROJECT_SEED_BRANCH
#   Exits with error if config is missing or project not found.
_resolve_project_config() {
  local script_dir="$1"
  local project_id="$2"
  local _cfg="$script_dir/scaffold.config.json"

  if [[ ! -f "$_cfg" ]]; then
    echo "Error: scaffold.config.json not found at $_cfg" >&2
    echo "Run ./setup.sh or copy scaffold.config.example.json and configure it." >&2
    exit 1
  fi

  PROJECT_HOOK_BUILD=""
  PROJECT_HOOK_LINT=""
  PROJECT_HOOK_JS_LINT=""
  PROJECT_AGENT_TYPE=""
  PROJECT_EFFORT=""
  PROJECT_SEED_BRANCH=""

  if jq -e --arg id "$project_id" '.projects[$id]' "$_cfg" >/dev/null 2>&1; then
    # Multi-project mode
    BARE_REPO_PATH=$(jq -r --arg id "$project_id" '.projects[$id].bareRepoPath // empty' "$_cfg")
    PROJECT_PATH=$(jq -r --arg id "$project_id" '.projects[$id].path // empty' "$_cfg")
    UE_ENGINE_PATH=$(jq -r --arg id "$project_id" '.projects[$id].engine.path // empty' "$_cfg")
    SERVER_PORT=$(jq -r --arg id "$project_id" '.projects[$id].serverPort // .server.port // 9100' "$_cfg")
    local _raw_build
    _raw_build=$(jq -r --arg id "$project_id" '.projects[$id].build.scriptPath // .build.scriptPath // "build.py"' "$_cfg")
    BUILD_SCRIPT_NAME=$(basename "$_raw_build")
    local _raw_test
    _raw_test=$(jq -r --arg id "$project_id" '.projects[$id].build.testScriptPath // .build.testScriptPath // "run_tests.py"' "$_cfg")
    TEST_SCRIPT_NAME=$(basename "$_raw_test")
    DEFAULT_TEST_FILTERS=$(jq -r --arg id "$project_id" '.projects[$id].build.defaultTestFilters // .build.defaultTestFilters // [] | if type == "array" then join(" ") else . end' "$_cfg")
    LOGS_PATH=$(jq -r --arg id "$project_id" '.projects[$id].logsPath // empty' "$_cfg")
    PROJECT_HOOK_BUILD=$(jq -r --arg id "$project_id" '.projects[$id].hooks.buildIntercept // empty' "$_cfg")
    PROJECT_HOOK_LINT=$(jq -r --arg id "$project_id" '.projects[$id].hooks.cppLint // empty' "$_cfg")
    PROJECT_HOOK_JS_LINT=$(jq -r --arg id "$project_id" '.projects[$id].hooks.jsLint // empty' "$_cfg")
    PROJECT_AGENT_TYPE=$(jq -r --arg id "$project_id" '.projects[$id].agentType // empty' "$_cfg")
    PROJECT_EFFORT=$(jq -r --arg id "$project_id" '.projects[$id].effort // empty' "$_cfg")
    PROJECT_SEED_BRANCH=$(jq -r --arg id "$project_id" '.projects[$id].seedBranch // empty' "$_cfg")
  elif [[ "$project_id" == "default" ]]; then
    # Legacy mode
    UE_ENGINE_PATH="$(jq -r '.engine.path // empty' "$_cfg")"
    PROJECT_PATH="$(jq -r '.project.path // empty' "$_cfg")"
    BARE_REPO_PATH="$(jq -r '.server.bareRepoPath // empty' "$_cfg")"
    SERVER_PORT="$(jq -r '.server.port // 9100' "$_cfg")"
    local _raw_build
    _raw_build="$(jq -r '.build.scriptPath // "build.py"' "$_cfg")"
    BUILD_SCRIPT_NAME="$(basename "$_raw_build")"
    local _raw_test
    _raw_test="$(jq -r '.build.testScriptPath // "run_tests.py"' "$_cfg")"
    TEST_SCRIPT_NAME="$(basename "$_raw_test")"
    DEFAULT_TEST_FILTERS="$(jq -r '.build.defaultTestFilters // [] | join(" ")' "$_cfg")"
    LOGS_PATH="$(jq -r '.logs.path // empty' "$_cfg")"
    PROJECT_HOOK_BUILD=$(jq -r '.hooks.buildIntercept // empty' "$_cfg")
    PROJECT_HOOK_LINT=$(jq -r '.hooks.cppLint // empty' "$_cfg")
    PROJECT_HOOK_JS_LINT=$(jq -r '.hooks.jsLint // empty' "$_cfg")
    PROJECT_EFFORT=$(jq -r '.container.effort // empty' "$_cfg")
    PROJECT_SEED_BRANCH=$(jq -r '.tasks.seedBranch // empty' "$_cfg")
  else
    local _available
    _available=$(jq -r '.projects // {} | keys | join(", ")' "$_cfg")
    echo "Error: Project '$project_id' not found in scaffold.config.json." >&2
    if [[ -n "$_available" ]]; then
      echo "Available projects: $_available" >&2
    else
      echo "No projects defined. Add a 'projects' map to scaffold.config.json or omit --project." >&2
    fi
    exit 1
  fi

  _validate_hook_values "scaffold.config.json" "$PROJECT_HOOK_BUILD" "$PROJECT_HOOK_LINT" "$PROJECT_HOOK_JS_LINT"

  if [[ -z "$LOGS_PATH" ]]; then
    LOGS_PATH="$script_dir/logs"
  fi
  mkdir -p "$LOGS_PATH"
}

# _resolve_agent_vars
#   Resolves AGENT_NAME, AGENT_TYPE, MAX_TURNS, worker mode, branch names,
#   and LOG_VERBOSITY from CLI overrides and environment defaults.
#   Requires _CLI_* variables to be set (from parse-launch-args.sh).
_resolve_agent_vars() {
  AGENT_NAME="${_CLI_AGENT_NAME:-${AGENT_NAME:-agent-1}}"
  if [[ "$_CLI_NO_AGENT" == "true" ]]; then
    AGENT_TYPE=""
  elif [[ -n "$_CLI_TEAM" ]]; then
    AGENT_TYPE="${_CLI_AGENT_TYPE:-${PROJECT_AGENT_TYPE:-${AGENT_TYPE:-}}}"
  else
    AGENT_TYPE="${_CLI_AGENT_TYPE:-${PROJECT_AGENT_TYPE:-${AGENT_TYPE:-}}}"
    if [[ -z "$AGENT_TYPE" ]]; then
      echo "Error: AGENT_TYPE is not set. Set it in .env, scaffold.config.json, or pass --agent-type." >&2
      exit 1
    fi
  fi

  _validate_identifier "AGENT_NAME" "$AGENT_NAME" || exit 1
  if [[ -n "$AGENT_TYPE" ]]; then
    _validate_identifier "AGENT_TYPE" "$AGENT_TYPE" || exit 1
  fi

  MAX_TURNS="${MAX_TURNS:-200}"
  # --parallel implies pump mode
  if [ "$_CLI_PARALLEL" -ge 1 ] 2>/dev/null; then
    _CLI_PUMP=true
  fi

  if [[ "$_CLI_PUMP" == "true" ]]; then
    WORKER_MODE=true
    WORKER_SINGLE_TASK=false
    AGENT_MODE=pump
  elif [[ "$_CLI_WORKER" == "true" ]]; then
    WORKER_MODE=true
  else
    WORKER_MODE="${WORKER_MODE:-false}"
  fi
  AGENT_MODE="${AGENT_MODE:-single}"
  WORKER_POLL_INTERVAL="${WORKER_POLL_INTERVAL:-30}"
  WORKER_SINGLE_TASK="${WORKER_SINGLE_TASK:-true}"
  LOG_VERBOSITY="${_CLI_VERBOSITY:-${LOG_VERBOSITY:-normal}}"

  case "$LOG_VERBOSITY" in
    quiet|normal|verbose) ;;
    *) echo "Error: --verbosity must be quiet, normal, or verbose (got '$LOG_VERBOSITY')" >&2; exit 1 ;;
  esac

  # Reasoning-effort cascade: CLI > scaffold.config.json > env (.env) > built-in default (high).
  CLAUDE_EFFORT="${_CLI_EFFORT:-${PROJECT_EFFORT:-${CLAUDE_EFFORT:-high}}}"

  case "$CLAUDE_EFFORT" in
    low|medium|high|xhigh|max) ;;
    *) echo "Error: CLAUDE_EFFORT must be one of low, medium, high, xhigh, max (got '$CLAUDE_EFFORT')" >&2; exit 1 ;;
  esac

  # Branch names
  AGENT_BRANCH="docker/${PROJECT_ID}/${AGENT_NAME}"
  local _default_root="${PROJECT_SEED_BRANCH:-docker/${PROJECT_ID}/current-root}"
  ROOT_BRANCH="${ROOT_BRANCH:-$_default_root}"
  WORK_BRANCH="$AGENT_BRANCH"

  if [[ "$ROOT_BRANCH" != "$_default_root" ]]; then
    echo "Warning: ROOT_BRANCH overridden via environment to '$ROOT_BRANCH' (config default: '$_default_root')" >&2
  fi

  if [[ -n "$ROOT_BRANCH" ]]; then
    _validate_branch_name "$ROOT_BRANCH" || exit 1
  fi
}

# _validate_required_config
#   Checks that BARE_REPO_PATH and UE_ENGINE_PATH (when needed) are set.
_validate_required_config() {
  local _cfg="$1"
  local -a _errors=()

  if [[ -z "${BARE_REPO_PATH:-}" ]]; then
    _errors+=("BARE_REPO_PATH is not set. Set it in scaffold.config.json.")
  fi

  if [[ -z "${UE_ENGINE_PATH:-}" ]]; then
    local _has_engine=false
    if jq -e --arg id "$PROJECT_ID" '.projects[$id].engine' "$_cfg" >/dev/null 2>&1; then
      _has_engine=true
    elif [[ "$PROJECT_ID" == "default" ]] && jq -e '.engine.path // empty | select(. != "")' "$_cfg" >/dev/null 2>&1; then
      _has_engine=true
    fi
    if [[ "$_has_engine" == true ]]; then
      _errors+=("UE_ENGINE_PATH is not set. Set engine.path in scaffold.config.json.")
    fi
  fi

  if [[ ${#_errors[@]} -gt 0 ]]; then
    echo "Configuration errors:" >&2
    for err in "${_errors[@]}"; do
      echo "  - $err" >&2
    done
    exit 1
  fi
}
