#!/bin/bash
# scripts/lib/launch-container.sh -- Docker container launch helpers.
#
# Provides _compose_project_name and _launch_container for starting
# agent containers via docker compose.
# Source this file; do not execute it directly.
#
# Requires: COMPOSE_CMD (set via compose-detect.sh _detect_compose)

# Guard against double-sourcing
[[ -n "${_LIB_LAUNCH_CONTAINER_LOADED:-}" ]] && return 0
readonly _LIB_LAUNCH_CONTAINER_LOADED=1

# _compose_project_name <project_id> <agent_name>
#   Returns the docker compose project name for an agent.
_compose_project_name() {
  echo "claude-${1}-${2}"
}

# _launch_container <agent_name> <compose_dir> <compose_files...> [-- ENV_OVERRIDES...]
#   Launches a container using docker compose with the given compose files.
#   Arguments after "--" are treated as VAR=VALUE env overrides.
#   Requires COMPOSE_CMD to be set (via _detect_compose).
_launch_container() {
  local _lc_agent="$1"; shift
  local _lc_compose_dir="$1"; shift

  # Collect compose file flags and env overrides
  local -a _lc_files=()
  local -a _lc_env=()
  local _lc_past_separator=false

  for arg in "$@"; do
    if [[ "$arg" == "--" ]]; then
      _lc_past_separator=true
      continue
    fi
    if [[ "$_lc_past_separator" == true ]]; then
      _lc_env+=("$arg")
    else
      _lc_files+=(-f "$arg")
    fi
  done

  local _lc_project_name
  _lc_project_name="$(_compose_project_name "${PROJECT_ID}" "$_lc_agent")"

  (cd "$_lc_compose_dir" && env "${_lc_env[@]}" \
    "${COMPOSE_CMD[@]}" "${_lc_files[@]}" --project-name "$_lc_project_name" up --build --detach)
}
