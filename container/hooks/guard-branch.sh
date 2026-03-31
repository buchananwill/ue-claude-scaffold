#!/bin/bash
# PreToolUse hook: blocks commands that would switch the agent off their
# assigned branch.  The agent can read any ref via git log, git show,
# git diff, etc. — they just cannot move HEAD.
#
# Blocked commands: git checkout, git switch, git branch -m/-M/-d/-D.
# Allowed: git checkout -- <file> (restore a file, doesn't switch branch).

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only act on git commands
if ! echo "$COMMAND" | grep -qE '^\s*git\s'; then
    exit 0
fi

# Block: git checkout <branch> (but allow git checkout -- <file>)
if echo "$COMMAND" | grep -qE 'git\s+checkout\s' && \
   ! echo "$COMMAND" | grep -qE 'git\s+checkout\s+--\s'; then
    echo "Blocked: Branch switching is not permitted. You are assigned to ${WORK_BRANCH}." >&2
    echo "Only work committed to your assigned branch will be persisted." >&2
    echo "Use 'git show <ref>:<path>' or 'git diff <ref>' to read other branches." >&2
    exit 2
fi

# Block: git switch
if echo "$COMMAND" | grep -qE 'git\s+switch\s'; then
    echo "Blocked: Branch switching is not permitted. You are assigned to ${WORK_BRANCH}." >&2
    echo "Only work committed to your assigned branch will be persisted." >&2
    exit 2
fi

# Block: git branch -m/-M/-d/-D (rename or delete branches)
if echo "$COMMAND" | grep -qE 'git\s+branch\s+-[mMdD]'; then
    echo "Blocked: Branch manipulation is not permitted. You are assigned to ${WORK_BRANCH}." >&2
    exit 2
fi

exit 0
