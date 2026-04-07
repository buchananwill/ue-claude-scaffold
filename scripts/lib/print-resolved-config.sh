#!/bin/bash
# scripts/lib/print-resolved-config.sh -- Pretty-print resolved launch config.
#
# Displays the resolved configuration for both dry-run and actual launch paths.
# Source this file; do not execute it directly.

# Guard against double-sourcing
[[ -n "${_LIB_PRINT_RESOLVED_CONFIG_LOADED:-}" ]] && return 0
readonly _LIB_PRINT_RESOLVED_CONFIG_LOADED=1

# _print_resolved_config
#   Prints the resolved configuration to stdout.
#   Reads from the following global variables:
#     AGENT_NAME, AGENT_BRANCH, ROOT_BRANCH, WORK_BRANCH, AGENT_TYPE,
#     PROJECT_ID, MAX_TURNS, BARE_REPO_PATH, UE_ENGINE_PATH, SERVER_PORT,
#     WORKER_MODE, WORKER_POLL_INTERVAL, WORKER_SINGLE_TASK, AGENT_MODE,
#     LOG_VERBOSITY, HOOK_BUILD_INTERCEPT, HOOK_CPP_LINT,
#     _CLI_PARALLEL, _CLI_FRESH, SCRIPT_DIR
_print_resolved_config() {
  echo ""
  echo "=== Resolved Configuration ==="
  echo "  AGENT_NAME:       ${AGENT_NAME:-}"
  echo "  AGENT_BRANCH:     ${AGENT_BRANCH:-}"
  echo "  ROOT_BRANCH:      ${ROOT_BRANCH:-}"
  echo "  WORK_BRANCH:      ${WORK_BRANCH:-}"
  echo "  AGENT_TYPE:       ${AGENT_TYPE:-}"
  echo "  PROJECT_ID:       ${PROJECT_ID:-}"
  if [[ -d "${SCRIPT_DIR:-}/dynamic-agents" && -f "${SCRIPT_DIR:-}/dynamic-agents/${AGENT_TYPE:-}.md" ]]; then
    echo "  AGENT_COMPILED:   yes (dynamic-agents/${AGENT_TYPE}.md)"
    local -a _sub_agents=()
    for _candidate in "${SCRIPT_DIR}"/dynamic-agents/*.md; do
      local _cname
      _cname="$(basename "${_candidate%.md}")"
      if [[ "$_cname" != "$AGENT_TYPE" ]]; then
        _sub_agents+=("$_cname")
      fi
    done
    if [[ ${#_sub_agents[@]} -gt 0 ]]; then
      local _sub_list
      _sub_list=$(IFS=', '; echo "${_sub_agents[*]}")
      echo "  SUB_AGENT_CANDIDATES: $_sub_list"
    fi
  else
    echo "  AGENT_COMPILED:   no (static agents fallback)"
  fi
  echo "  MAX_TURNS:        ${MAX_TURNS:-}"
  echo "  BARE_REPO_PATH:   ${BARE_REPO_PATH:-}"
  echo "  UE_ENGINE_PATH:   ${UE_ENGINE_PATH:-}"
  echo "  SERVER_PORT:      ${SERVER_PORT:-9100}"
  echo "  WORKER_MODE:      ${WORKER_MODE:-}"
  echo "  WORKER_POLL_INT:  ${WORKER_POLL_INTERVAL:-}"
  echo "  WORKER_SINGLE:    ${WORKER_SINGLE_TASK:-}"
  echo "  AGENT_MODE:       ${AGENT_MODE:-}"
  echo "  LOG_VERBOSITY:    ${LOG_VERBOSITY:-}"
  echo "  PARALLEL:         ${_CLI_PARALLEL:-0}"
  echo "  FRESH:            ${_CLI_FRESH:-false}"
  echo "  HOOKS:"
  echo "    buildIntercept: ${HOOK_BUILD_INTERCEPT:-}"
  echo "    cppLint:        ${HOOK_CPP_LINT:-}"
  if [ "${_CLI_PARALLEL:-0}" -ge 1 ] 2>/dev/null; then
    echo ""
    echo "Parallel agent branches:"
    for i in $(seq 1 "${_CLI_PARALLEL}"); do
      echo "  agent-${i} -> docker/${PROJECT_ID}/agent-${i}"
    done
  fi
  echo ""
}
