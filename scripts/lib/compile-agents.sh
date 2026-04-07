#!/bin/bash
# scripts/lib/compile-agents.sh -- Dynamic agent compilation.
#
# Compiles agent definitions from dynamic-agents/ using the server's
# compile-agent.js tool, with fallback to static agents/ copies.
# Source this file; do not execute it directly.

# Guard against double-sourcing
[[ -n "${_LIB_COMPILE_AGENTS_LOADED:-}" ]] && return 0
readonly _LIB_COMPILE_AGENTS_LOADED=1

# _compile_agents <script_dir> <agent_type> [--team]
#   Compiles agent definitions into .compiled-agents/.
#   Sets AGENTS_PATH to the compiled agents directory.
#   Pass --team if in team mode (suppresses "no agents found" warning).
_compile_agents() {
  local script_dir="$1"
  local agent_type="$2"
  local is_team="${3:-}"

  COMPILED_AGENTS_DIR="$script_dir/.compiled-agents"
  [[ -n "$COMPILED_AGENTS_DIR" && "$COMPILED_AGENTS_DIR" == "$script_dir/"* ]] || {
    echo "Error: unsafe COMPILED_AGENTS_DIR: $COMPILED_AGENTS_DIR" >&2
    exit 1
  }
  rm -rf "$COMPILED_AGENTS_DIR"
  mkdir -p "$COMPILED_AGENTS_DIR"

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
  else
    # Fallback: copy static agents directory (legacy behaviour)
    if [[ -d "$script_dir/agents" ]]; then
      cp "$script_dir/agents/"*.md "$COMPILED_AGENTS_DIR/" 2>/dev/null || true
    fi
    if [[ "$is_team" != "--team" ]] && ! ls "$COMPILED_AGENTS_DIR"/*.md &>/dev/null; then
      echo "Warning: No .md agent files found in compiled agents directory." >&2
      echo "  The container may still work if agents are provided from another source." >&2
    fi
  fi

  AGENTS_PATH="$COMPILED_AGENTS_DIR"
}
