# Debrief 0165 -- Phase 1: Pass --no-renames to sync diffs and harden delete path

## Task Summary

Implement Phase 1 of the fix for staging worktree ghost files (issue 047). The root cause is that git's rename detection silently absorbs delete+add pairs into a single R status, so the delete filter misses the old path and the add filter misses it too. The old file persists as a ghost in the staging worktree, causing false build failures.

## Changes Made

- **server/src/routes/build.ts** (modified)
  - Added `--no-renames` to the `git diff --diff-filter=AMCR` invocation so renames are reported as independent add+delete operations.
  - Added `--no-renames` to the `git diff --diff-filter=D` invocation for the same reason.
  - Captured the return value of the `git rm` command. On failure, added a fallback that runs `git reset --hard FETCH_HEAD`, calls `updateSyncRef`, and returns `"changed"` -- mirroring the existing checkout fallback pattern.

## Design Decisions

- Kept the `AMCR` diff filter letters intact even though `C` and `R` are dead letters with `--no-renames`. This keeps the diff inert and avoids a confusing removal that could be misread as intentional filter narrowing.
- The `git rm` fallback mirrors the existing `git checkout` fallback exactly (same reset command, same error handling, same updateSyncRef + return pattern) for consistency.

## Build & Test Results

Pending initial build.

## Open Questions / Risks

- None for Phase 1. The change is minimal and mechanical.

## Suggested Follow-ups

- Phase 2: Regression test that commits a rename-detectable change and asserts the old path is removed.
- Phase 3: Unstick the live piste-perfect/agent-2 staging worktree (operator action).
- Phase 4: Close issue 047.
