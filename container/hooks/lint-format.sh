#!/bin/bash
# PostToolUse hook: run Prettier + ESLint on edited JS/TS files inside containers.
# Prettier auto-formats; ESLint violations are returned as additionalContext.
# Best-effort: skips silently if tools are not installed in the workspace.

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Only act on JS/TS/JSON files
case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx|*.json) ;;
  *) exit 0 ;;
esac

# --- Prettier (best-effort) ---
# Walk up from FILE_PATH looking for a node_modules/.bin/prettier
_find_tool() {
  local tool="$1" dir
  dir=$(dirname "$FILE_PATH")
  while [ "$dir" != "/" ]; do
    if [ -x "$dir/node_modules/.bin/$tool" ]; then
      echo "$dir/node_modules/.bin/$tool"
      return 0
    fi
    dir=$(dirname "$dir")
  done
  return 1
}

PRETTIER=$(_find_tool prettier) && "$PRETTIER" --write "$FILE_PATH" >/dev/null 2>&1 || true

# --- ESLint (best-effort) ---
# Find eslint and run from its package root so it picks up the config
LINT_OUTPUT=""
_eslint_dir() {
  local dir
  dir=$(dirname "$FILE_PATH")
  while [ "$dir" != "/" ]; do
    if [ -x "$dir/node_modules/.bin/eslint" ] && [ -f "$dir/eslint.config.js" -o -f "$dir/eslint.config.mjs" -o -f "$dir/eslint.config.cjs" -o -f "$dir/.eslintrc.js" -o -f "$dir/.eslintrc.json" ]; then
      echo "$dir"
      return 0
    fi
    dir=$(dirname "$dir")
  done
  return 1
}

ESLINT_ROOT=$(_eslint_dir) && \
  LINT_OUTPUT=$(cd "$ESLINT_ROOT" && npx eslint --no-warn-ignored --format stylish "$FILE_PATH" 2>&1) || true

# If eslint found issues, inject them as context for the model
if [ -n "$LINT_OUTPUT" ]; then
  ESCAPED=$(echo "$LINT_OUTPUT" | jq -Rs .)
  cat <<ENDJSON
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": $ESCAPED
  }
}
ENDJSON
fi

exit 0
