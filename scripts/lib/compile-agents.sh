#!/bin/bash
# scripts/lib/compile-agents.sh -- Dynamic agent compilation.
#
# Compiles agent definitions from dynamic-agents/ using the server's
# compile-agent.js tool, with fallback to static agents/ copies.
# Source this file; do not execute it directly.

# Guard against double-sourcing
[[ -n "${_LIB_COMPILE_AGENTS_LOADED:-}" ]] && return 0
readonly _LIB_COMPILE_AGENTS_LOADED=1

# _compile_agents <script_dir> <agent_type> [team_mode]
#   Compiles agent definitions into .compiled-agents/.
#   Sets AGENTS_PATH to the compiled agents directory.
#   Pass "true" for team_mode to suppress "no agents found" warning.
#
#   Compilation source selection:
#     1. If agent_type is non-empty and dynamic-agents/${agent_type}.md exists,
#        compile that single lead agent (non-FSM mode: --prompt / --team).
#     2. Else if PROJECT_ROLE_AGENTS is non-empty (FSM mode), compile every
#        agent name in that space-separated list. This warms the cache for the
#        engineer + arbitrator + every reviewer the FSM may dispatch.
#     3. Else, fall back to copying the static agents/ directory verbatim
#        (legacy / degraded mode).
_compile_agents() {
  local script_dir="$1"
  local agent_type="$2"
  local _ca_team_mode="${3:-}"

  COMPILED_AGENTS_DIR="$script_dir/.compiled-agents"
  mkdir -p "$COMPILED_AGENTS_DIR"

  # Clear stale outputs from a previous launch so an agent that is no longer
  # referenced (e.g. after a project switch or after agentType was dropped
  # from scaffold.config.json) does not linger and shadow a fresh compile.
  rm -f "$COMPILED_AGENTS_DIR"/*.md "$COMPILED_AGENTS_DIR"/*.meta.json 2>/dev/null || true

  if [[ ! -f "$script_dir/server/dist/bin/compile-agent.js" ]]; then
    echo "Error: compile-agent.js not found at $script_dir/server/dist/bin/" >&2
    echo "  Run 'cd server && npm run build' first." >&2
    exit 1
  fi

  if [[ -n "$agent_type" && -d "$script_dir/dynamic-agents" && -f "$script_dir/dynamic-agents/${agent_type}.md" ]]; then
    echo "Compiling dynamic agent: ${agent_type}..."
    if ! node "$script_dir/server/dist/bin/compile-agent.js" \
      "$script_dir/dynamic-agents/${agent_type}.md" \
      -o "$COMPILED_AGENTS_DIR" \
      --skills-dir "$script_dir/skills" \
      --dynamic-dir "$script_dir/dynamic-agents" \
      --recursive; then
      echo "Error: Agent compilation failed for '${agent_type}'. See above for details." >&2
      exit 1
    fi
  elif [[ -z "$agent_type" && -n "${PROJECT_ROLE_AGENTS:-}" && -d "$script_dir/dynamic-agents" ]]; then
    echo "Compiling FSM role agents: ${PROJECT_ROLE_AGENTS}"
    local _role
    for _role in $PROJECT_ROLE_AGENTS; do
      if [[ ! -f "$script_dir/dynamic-agents/${_role}.md" ]]; then
        echo "Error: agentRoles references '${_role}' but dynamic-agents/${_role}.md does not exist." >&2
        exit 1
      fi
      if ! node "$script_dir/server/dist/bin/compile-agent.js" \
        "$script_dir/dynamic-agents/${_role}.md" \
        -o "$COMPILED_AGENTS_DIR" \
        --skills-dir "$script_dir/skills" \
        --dynamic-dir "$script_dir/dynamic-agents" \
        --recursive; then
        echo "Error: Agent compilation failed for role agent '${_role}'." >&2
        exit 1
      fi
    done
  else
    # Fallback: copy static agents directory (legacy behaviour)
    if [[ -d "$script_dir/agents" ]]; then
      cp "$script_dir/agents/"*.md "$COMPILED_AGENTS_DIR/" 2>/dev/null || true
    fi
    if [[ "$_ca_team_mode" != "true" ]] && ! ls "$COMPILED_AGENTS_DIR"/*.md &>/dev/null; then
      echo "Warning: No .md agent files found in compiled agents directory." >&2
      echo "  The container may still work if agents are provided from another source." >&2
    fi
  fi

  AGENTS_PATH="$COMPILED_AGENTS_DIR"
}
