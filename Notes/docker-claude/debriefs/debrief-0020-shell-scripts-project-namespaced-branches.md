# Debrief 0020 -- Shell Scripts: Project-Namespaced Branches

## Task Summary

Phase 4 of the server-multi-tenancy plan: update `launch.sh` and `setup.sh` to use project-namespaced branch patterns (`docker/{project-id}/{agent-name}` instead of `docker/{agent-name}`), add an agent collision guard, and implement migration for existing bare repos with old-style branch names.

## Changes Made

- **launch.sh**: Updated branch construction from `docker/${AGENT_NAME}` to `docker/${PROJECT_ID}/${AGENT_NAME}`, `ROOT_BRANCH` from `docker/current-root` to `docker/${PROJECT_ID}/current-root`, team member branch from `docker/${_MEMBER_NAME}` to `docker/${PROJECT_ID}/${_MEMBER_NAME}`, parallel mode branch from `docker/${_AGENT}` to `docker/${PROJECT_ID}/${_AGENT}`. Updated help text and dry-run display strings.
- **launch.sh**: Added agent collision guard that queries the coordination server before launching, checking if the agent is already active for the given project.
- **setup.sh**: Updated `_create_bare_and_root` to accept project ID parameter and create `docker/{pid}/current-root` instead of `docker/current-root`.
- **setup.sh**: Updated `_init_bare_repo` to accept project ID, added migration logic that detects old-style `docker/current-root` branches and copies them to `docker/{pid}/current-root` (preserving old branches for in-flight containers). Updated warning messages to reference new branch pattern.
- **setup.sh**: Updated call sites in both multi-project and single-project modes to pass project ID.

## Design Decisions

- The collision guard uses `curl -sf` with `2>/dev/null` to suppress errors when the server is not reachable -- this avoids blocking launches when the server hasn't started yet (the existing health check handles that).
- Migration copies rather than renames old branches, so in-flight containers using `docker/current-root` are not disrupted.
- For legacy single-project mode, `"default"` is used as the project ID, matching the existing `PROJECT_ID` default.

## Build & Test Results

- Shell syntax validation: all 4 scripts pass `bash -n`
- TypeScript typecheck: clean (no errors)
- Server tests: pending (running in background)

## Open Questions / Risks

- Container scripts (`entrypoint.sh`, `guard-branch.sh`, `push-after-commit.sh`) use `$WORK_BRANCH` as an opaque value and should not need changes per the plan, but if any of them hardcode `docker/` prefix patterns, they may need updates.

## Suggested Follow-ups

- Add integration tests that verify branch name construction with various PROJECT_ID values.
- Consider adding a cleanup command to remove old-style `docker/current-root` branches after all containers have been migrated.
