#!/bin/bash
# scripts/lib/stop-helpers.sh — Helpers for stopping Docker Compose projects.
#
# Provides _signal_and_stop_projects for signalling agents via the coordination
# server and then running docker compose down on each project.
# Requires: COMPOSE_CMD (array) to be set before sourcing.
# Source this file; do not execute it directly.

# Guard against double-sourcing
[[ -n "${_LIB_STOP_HELPERS_LOADED:-}" ]] && return 0
readonly _LIB_STOP_HELPERS_LOADED=1

# _signal_stop <agent_name> <base_url>
#   Sends a DELETE to the coordination server to set the agent's status
#   to 'stopping'. This must happen BEFORE docker compose down so the
#   container's _shutdown handler sees status='stopping'.
_signal_stop() {
  local agent_name="$1"
  local base_url="$2"
  [[ "$agent_name" =~ ^[a-zA-Z0-9_-]{1,64}$ ]] || return 1
  curl -sf -X DELETE "${base_url}/agents/${agent_name}" --max-time 5 >/dev/null 2>&1 || true
}

# _signal_and_stop_projects <base_url> <compose_dir> [project_id] <project_names...>
#   For each docker compose project name:
#     1. Extracts the agent name using the known project_id
#     2. Signals the coordination server to set agent status to 'stopping'
#     3. Runs docker compose down
#   Project names must follow the convention: claude-<project_id>-<agent_name>
#   If project_id is empty, the signal step is skipped (drain mode already
#   paused agents server-side, and default stop is a hard kill).
#   Prints a count of stopped containers on completion.
_signal_and_stop_projects() {
  local base_url="$1"
  local compose_dir="$2"
  local project_id="$3"
  shift 3

  if [[ $# -eq 0 ]]; then
    echo "No containers to stop."
    return 0
  fi

  local -a projects=("$@")
  local stopped=0
  local agent_name

  # Signal all agents via server BEFORE killing containers, so the
  # entrypoint's _shutdown handler can complete the two-call DELETE.
  for project in "${projects[@]}"; do
    # Extract agent name: strip "claude-<project_id>-" prefix.
    # The project name format is claude-${PROJECT_ID}-${AGENT_NAME}.
    if [[ -z "$project_id" ]]; then
      # No project_id known — skip signal (drain already paused server-side,
      # default stop is a hard kill).
      continue
    fi
    agent_name="${project#claude-${project_id}-}"
    if [[ -z "$agent_name" || "$agent_name" == "$project" ]]; then
      echo "Warning: could not extract agent name from project: $project" >&2
      continue
    fi
    if [[ ! "$agent_name" =~ ^[a-zA-Z0-9_-]{1,64}$ ]]; then
      echo "Warning: skipping agent with unexpected name: $agent_name" >&2
      continue
    fi
    _signal_stop "$agent_name" "$base_url"
  done

  for project in "${projects[@]}"; do
    echo "Stopping $project ..."
    (cd "$compose_dir" && "${COMPOSE_CMD[@]}" --project-name "$project" down 2>/dev/null) || true
    stopped=$((stopped + 1))
  done

  echo "Stopped $stopped container(s)."
}
