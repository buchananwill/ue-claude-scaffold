#!/bin/bash
# container/lib/finalize.sh — Final commit-and-push block.
# Sourced by entrypoint.sh; do not execute directly.

_finalize_workspace() {
    # Commit any uncommitted work, push to bare repo, print audit info.
    cd /workspace
    git add -A
    if ! git diff --cached --quiet; then
        git commit -m "Container final commit" --no-gpg-sign
    fi

    # Audit: log what the agent actually changed (diff from branch start)
    echo ""
    echo "── Git diff stats (cumulative changes on branch) ──"
    git diff --stat "origin/${WORK_BRANCH}" HEAD 2>/dev/null || echo "(could not compute diff stats)"
    echo "── Git log (commits this session) ──"
    git log --oneline "origin/${WORK_BRANCH}..HEAD" 2>/dev/null || echo "(could not compute log)"
    echo ""

    git push origin "HEAD:${WORK_BRANCH}" --force
    echo "Final state pushed to bare repo"
}
