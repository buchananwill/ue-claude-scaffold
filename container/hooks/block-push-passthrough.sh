#!/bin/bash
# Blocks manual git push commands from Claude Code.
# Pushes are handled automatically by the build/test intercept hook.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if echo "$COMMAND" | grep -qiE 'git\s+(push|force)'; then
    echo "Blocked: Push operations are handled automatically by the build/test hooks. Do not push manually." >&2
    exit 2
fi

exit 0
