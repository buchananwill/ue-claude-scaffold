# Container Git: Merge Before Push

## Goal

Make running containers pick up fixes merged into their bare-repo branch via `POST /sync/plans` (with `targetAgents`),
instead of force-pushing over them and destroying the merge.

## Context

The operator workflow for hotfixing a running agent is: fix the code in the exterior repo, commit, then
`POST /sync/plans` with `targetAgents: ["agent-1"]`. This merges the fix into `docker/{projectId}/agent-1` in the bare
repo. But the container never fetches from the bare repo after startup. Two hook scripts force-push (
`git push origin HEAD:${WORK_BRANCH} --force`), which overwrites the merge commit and destroys the fix. The agent keeps
building against its stale local tree.

The two force-push sites are:

- [intercept_build_test.sh](../container/hooks/intercept_build_test.sh) line 81
- [push-after-commit.sh](../container/hooks/push-after-commit.sh) line 39

Both need to fetch and merge the remote branch before pushing, so that upstream merges are incorporated rather than
obliterated. Merge (not rebase) — this project preserves true timelines.

The container startup in [workspace-setup.sh](../container/lib/workspace-setup.sh) lines 20-22 already does
`git fetch origin` + `git reset --hard origin/${WORK_BRANCH}` — that's correct for the initial clone. The problem is
that no fetch ever happens again after startup.

## Phase 1 — Extract a shared merge-and-push script

**Outcome:** A new [container/lib/merge-push.sh](../container/lib/merge-push.sh) script provides a `_merge_and_push`
function that both hooks source. The function fetches the remote branch, merges `origin/${WORK_BRANCH}` into the local
branch, then pushes (non-force). If the merge fails due to conflicts, it aborts the merge and falls back to force-push
with a warning (the operator's merge was incompatible with the agent's local work — the agent's work wins, and the
operator sees the warning in container logs).

**Types / APIs:**

```bash
# container/lib/merge-push.sh
# Source this file; do not execute directly.
#
# Requires: WORK_BRANCH (env var)
# Must be called from within the git workspace (CLAUDE_PROJECT_DIR or /workspace).

_merge_and_push() {
    # 1. git fetch origin $WORK_BRANCH
    # 2. git merge origin/$WORK_BRANCH --no-edit
    #    - On success: git push origin HEAD:$WORK_BRANCH (no --force)
    #    - On conflict: git merge --abort, git push origin HEAD:$WORK_BRANCH --force
    #                   + print warning to stderr
}
```

**Work:**

- Create [container/lib/merge-push.sh](../container/lib/merge-push.sh) with the `_merge_and_push` function.
- Guard against double-sourcing with the same pattern used in other `container/lib/` scripts (
  `_LIB_MERGE_PUSH_LOADED`).
- The fetch must be quiet (`2>/dev/null || true`) — a missing remote branch at this point is not fatal (the push will
  create it).
- If `origin/${WORK_BRANCH}` doesn't exist locally after fetch (first push for a new branch), skip the merge and push
  directly.
- The non-force push may fail if someone else updated the remote between fetch and push. If so, retry once (fetch,
  merge, push). If the second attempt also fails, fall back to force-push with a warning.

**Verification:** `bash -n container/lib/merge-push.sh` passes (syntax check). Manual test: launch a container, run
`POST /sync/plans` with `targetAgents` to merge a change into the agent's bare-repo branch, then trigger a build — the
build should include the merged change.

## Phase 2 — Wire merge-and-push into intercept_build_test.sh

**Outcome:** The build intercept hook fetches and merges before pushing, so that the staging worktree (which the server
creates from the bare-repo branch) includes both the agent's local commits and any upstream merges.

**Work:**

- In [intercept_build_test.sh](../container/hooks/intercept_build_test.sh), source the new library near the top (after
  the existing env var block, before the passthrough check): `source /claude-lib/merge-push.sh`
- Replace lines 75-81 (the commit-and-force-push block) with:
  ```bash
  git add -A

  if ! git diff --cached --quiet; then
      git commit -m "Container auto-commit for build/test" --no-gpg-sign
  fi

  _merge_and_push
  ```

**Verification:** `bash -n container/hooks/intercept_build_test.sh` passes. Functional test same as Phase 1
verification.

## Phase 3 — Wire merge-and-push into push-after-commit.sh

**Outcome:** Post-commit pushes also incorporate upstream merges instead of overwriting them.

**Work:**

- In [push-after-commit.sh](../container/hooks/push-after-commit.sh), source the new library near the top:
  `source /claude-lib/merge-push.sh`
- Replace lines 38-53 (the push block and error handling) with:
  ```bash
  if _merge_and_push 2>&1; then
      echo "Pushed to bare repo: ${WORK_BRANCH}" >&2
  else
      echo "ERROR: Failed to push to bare repo. Work may not be persisted externally." >&2
      # Notify coordination server of push failure
      PAYLOAD=$(jq -n --arg agent "$AGENT_NAME" --arg branch "$WORK_BRANCH" \
          '{"agent": $agent, "branch": $branch, "error": "push failed"}')
      curl -s -X POST "${SERVER_URL}/messages" \
          -H "Content-Type: application/json" \
          -H "X-Agent-Name: ${AGENT_NAME}" \
          -H "X-Project-Id: ${PROJECT_ID}" \
          -d "$(jq -n --arg channel "$AGENT_NAME" --argjson payload "$PAYLOAD" \
              '{"channel": $channel, "type": "push_failed", "payload": $payload}')" \
          --max-time 5 >/dev/null 2>&1 || true
  fi
  ```

**Verification:** `bash -n container/hooks/push-after-commit.sh` passes. Trigger a commit inside a running container and
confirm the push incorporates any upstream merges present on the bare-repo branch.

## Phase 4 — Update docker-compose mount for the new library

**Outcome:** The new `rebase-push.sh` file is available inside the container at `/claude-lib/rebase-push.sh`.

**Work:**

- Check [container/docker-compose.example.yml](../container/docker-compose.example.yml) for how `container/lib/` is
  mounted. If `container/lib/` is already mounted as `/claude-lib/` (or equivalent), no change needed — the new file is
  automatically available.
- If individual files are mounted rather than the directory, add a mount for `rebase-push.sh`.
- Update the example compose file. Remind the operator to rebuild/update their local `docker-compose.yml` if it's not
  committed.

**Verification:** `docker compose -f container/docker-compose.example.yml config` shows the mount. Operator rebuilds and
verifies `/claude-lib/rebase-push.sh` exists inside the container.
