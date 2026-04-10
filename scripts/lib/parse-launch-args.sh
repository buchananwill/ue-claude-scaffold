#!/bin/bash
# scripts/lib/parse-launch-args.sh -- CLI argument parser for launch.sh.
#
# Sets _CLI_* variables from command-line arguments.
# Source this file; do not execute it directly.

# Guard against double-sourcing
[[ -n "${_LIB_PARSE_LAUNCH_ARGS_LOADED:-}" ]] && return 0
readonly _LIB_PARSE_LAUNCH_ARGS_LOADED=1

# ── Usage ────────────────────────────────────────────────────────────────────
_launch_usage() {
  cat <<'USAGE'
Usage: ./launch.sh [OPTIONS]

Launch a containerized Claude Code agent against your Unreal Engine project.

Options:
  --agent-name NAME   Agent identifier (default: from .env or "agent-1")
  --agent-type TYPE   Agent type (required: set in .env, scaffold.config.json, or here)
  --project ID        Project identifier for multi-project configs (default: "default")
  --verbosity LEVEL   Message board verbosity: quiet, normal, verbose (default: normal)
  --worker            Run in task-queue worker mode (no plan file needed)
  --pump              Run in pump mode (multi-task worker with claim-next)
  --parallel N        Launch N parallel pump agents (implies --pump)
  --fresh             Reset agent branch to docker/current-root HEAD (clean start)
  --team TEAM_ID      Launch a design team (reads teams/<TEAM_ID>.json)
  --brief PATH        Repo-relative path to a brief file (required with --team)
  --prompt TEXT       Pass a direct prompt to the agent (bypasses task queue)
  --no-agent          Skip agent registration (for debugging/manual runs)
  --dry-run           Print resolved configuration and exit without launching
  --hooks             Force all hooks enabled (build intercept + C++ lint)
  --no-hooks          Force all hooks disabled
  --help              Show this help message and exit

Branch is docker/{project-id}/{agent-name}, forked from docker/{project-id}/current-root.

Examples:
  ./launch.sh --agent-name agent-2 --worker
  ./launch.sh --worker --agent-name worker-1
  ./launch.sh --pump --agent-name pump-1
  ./launch.sh --verbosity verbose
  ./launch.sh --parallel 3
  ./launch.sh --team design-team-1 --brief Notes/docker-claude/briefs/inventory.md
  ./launch.sh --dry-run
USAGE
}

# _parse_launch_args "$@"
#   Parses CLI flags and sets _CLI_* global variables.
#   Calls _launch_usage and exits on --help or unknown options.
_parse_launch_args() {
  _CLI_AGENT_NAME=""
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
  _CLI_HOOK_JS_LINT=""
  _CLI_PROMPT=""
  _CLI_NO_AGENT=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --agent-name)
        _CLI_AGENT_NAME="$2"; shift 2 ;;
      --agent-type)
        _CLI_AGENT_TYPE="$2"; shift 2 ;;
      --verbosity)
        _CLI_VERBOSITY="$2"; shift 2 ;;
      --worker)
        _CLI_WORKER=true; shift ;;
      --pump)
        _CLI_PUMP=true; shift ;;
      --parallel)
        _CLI_PARALLEL="$2"; shift 2
        if [[ ! "$_CLI_PARALLEL" =~ ^[1-9][0-9]*$ ]] || (( _CLI_PARALLEL > 20 )); then
          echo "Error: --parallel must be an integer between 1 and 20" >&2
          exit 1
        fi
        ;;
      --fresh)
        _CLI_FRESH=true; shift ;;
      --project)
        _CLI_PROJECT="$2"; shift 2 ;;
      --team)
        _CLI_TEAM="$2"; shift 2
        if [[ ! "$_CLI_TEAM" =~ ^[a-zA-Z0-9_-]{1,64}$ ]]; then
          echo "Error: --team value contains invalid characters: $_CLI_TEAM" >&2
          exit 1
        fi
        ;;
      --brief)
        _CLI_BRIEF="$2"; shift 2
        if [[ "$_CLI_BRIEF" == /* || "$_CLI_BRIEF" == *..* || "$_CLI_BRIEF" == .* || "$_CLI_BRIEF" == */.* ]]; then
          echo "Error: --brief must be a relative repo path without '..' or hidden directory components" >&2
          exit 1
        fi
        ;;
      --hooks)
        _CLI_HOOK_BUILD="true"; _CLI_HOOK_LINT="true"; _CLI_HOOK_JS_LINT="true"; shift ;;
      --no-hooks)
        _CLI_HOOK_BUILD="false"; _CLI_HOOK_LINT="false"; _CLI_HOOK_JS_LINT="false"; shift ;;
      --prompt)
        _CLI_PROMPT="$2"; shift 2 ;;
      --no-agent)
        _CLI_NO_AGENT=true; shift ;;
      --dry-run)
        _CLI_DRY_RUN=true; shift ;;
      --help)
        _launch_usage; exit 0 ;;
      *)
        echo "Unknown option: $1" >&2
        _launch_usage >&2
        exit 1 ;;
    esac
  done
}
