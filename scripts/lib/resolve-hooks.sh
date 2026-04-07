#!/bin/bash
# scripts/lib/resolve-hooks.sh -- Hook resolution cascade.
#
# Resolves HOOK_BUILD_INTERCEPT and HOOK_CPP_LINT from the cascade:
#   system default -> project -> team -> member -> CLI override
# Source this file; do not execute it directly.

# Guard against double-sourcing
[[ -n "${_LIB_RESOLVE_HOOKS_LOADED:-}" ]] && return 0
readonly _LIB_RESOLVE_HOOKS_LOADED=1

# shellcheck source=resolve-config.sh
source "$(dirname "${BASH_SOURCE[0]}")/resolve-config.sh"

# _resolve_hook_value <system> <project> <team> <member> <cli>
#   Returns the final hook value from the cascade, preferring later overrides.
_resolve_hook_value() {
  local result="$1"
  [[ -n "$2" ]] && result="$2"
  [[ -n "$3" ]] && result="$3"
  [[ -n "$4" ]] && result="$4"
  [[ -n "$5" ]] && result="$5"
  echo "$result"
}

# _resolve_hooks [member_json]
#   Sets HOOK_BUILD_INTERCEPT and HOOK_CPP_LINT.
#   Reads: PROJECT_ID, PROJECT_HOOK_BUILD, PROJECT_HOOK_LINT,
#          _CLI_HOOK_BUILD, _CLI_HOOK_LINT, TEAM_DEF, SCRIPT_DIR
_resolve_hooks() {
  local member_json="${1:-}"
  local _cfg="${SCRIPT_DIR}/scaffold.config.json"

  # System default: buildIntercept is true if project has a build script
  local sys_build="false"
  if jq -e --arg id "$PROJECT_ID" \
      '(.projects[$id].build.scriptPath // .build.scriptPath // empty) | select(. != "")' \
      "$_cfg" >/dev/null 2>&1; then
    sys_build="true"
  fi
  local sys_lint="false"

  # Team-level overrides
  local team_build="" team_lint=""
  if [[ -n "${TEAM_DEF:-}" && -f "${TEAM_DEF:-}" ]]; then
    team_build=$(jq -r '.hooks.buildIntercept // empty' "$TEAM_DEF")
    team_lint=$(jq -r '.hooks.cppLint // empty' "$TEAM_DEF")
  fi
  _validate_hook_values "team definition" "$team_build" "$team_lint"

  # Per-member overrides
  local member_build="" member_lint=""
  if [[ -n "$member_json" ]]; then
    member_build=$(printf '%s' "$member_json" | jq -r '.hooks.buildIntercept // empty')
    member_lint=$(printf '%s' "$member_json" | jq -r '.hooks.cppLint // empty')
  fi
  _validate_hook_values "member definition" "$member_build" "$member_lint"

  HOOK_BUILD_INTERCEPT=$(_resolve_hook_value "$sys_build" "$PROJECT_HOOK_BUILD" "$team_build" "$member_build" "${_CLI_HOOK_BUILD:-}")
  HOOK_CPP_LINT=$(_resolve_hook_value "$sys_lint" "$PROJECT_HOOK_LINT" "$team_lint" "$member_lint" "${_CLI_HOOK_LINT:-}")
}
