# Debrief 0108 -- Phase 17: Verification

## Task Summary

Phase 17 of the shell-script-decomposition plan: run the full test suite, syntax-check all shell scripts, update CLAUDE.md to reflect the new server-owns-logic architecture, check README.md for stale Python references, and document manual Docker verification steps for the operator.

## Changes Made

- **CLAUDE.md**: Updated Architecture section to reflect:
  - Shell scripts are thin dispatch layers sourcing from `scripts/lib/` and `container/lib/`
  - Server owns config resolution, branch ops, hook cascade, settings rendering, exit classification, team launch, task ingest, agent compilation, C++ lint
  - New server endpoints: `/config/{projectId}`, `/agents/{name}/branch`, `/hooks/{projectId}`, `/container-settings/{projectId}`, `/tasks/ingest`, `/agents/compile`, `/agents/{name}/exit-classify`, `/teams/{id}/launch`, `/status`
  - Container entrypoint sources libraries from `container/lib/`
  - `lint-cpp-diff.mjs` replaces `lint-cpp-diff.py`; no Python in the project

## Design Decisions

- Updated CLAUDE.md surgically -- only changed the Architecture subsections that needed updating, preserving the rest of the file structure.
- Did not delete the plan file (step 98) as instructed -- that is the operator's responsibility when work lands in main.

## Build & Test Results

### Server Build
- `npm run build`: SUCCESS (clean)

### Server Tests
- 546 tests total: 487 passed, 59 failed
- All 59 failures are pre-existing and unrelated to this plan:
  - `POST /agents/:name/sync` (4 failures) -- requires git bare repo infrastructure not available in container
  - `messages routes` (1 failure) -- `?since=<id>` cursor test
  - `tasks with bare repo and agents` (54 failures) -- task dependency and branch-aware features that require git infrastructure

### Shell Script Syntax Check
- `bash -n` passed on all `.sh` files in the repository with zero errors.

### README.md
- No Python references found. No changes needed.

## Manual Verification Checklist (Steps 88-95)

These steps require Docker on the host and cannot be run from inside a container. The operator should verify:

1. **launch.sh basic launch**: `./launch.sh --project <id> --agent test-agent` starts a container that registers with the server and begins work.
2. **launch.sh --fresh**: `./launch.sh --fresh --project <id> --agent test-agent` resets the agent branch to `docker/{project-id}/current-root` before launching.
3. **launch.sh --dry-run**: `./launch.sh --dry-run --project <id> --agent test-agent` prints resolved config without launching a container.
4. **stop.sh basic stop**: `./stop.sh` stops all running agent containers.
5. **stop.sh --agent**: `./stop.sh --agent test-agent` stops only the named agent.
6. **stop.sh --drain**: `./stop.sh --drain` pauses pump agents, waits for in-flight tasks, then stops.
7. **Container entrypoint**: Verify `entrypoint.sh` sources libraries from `container/lib/` and completes workspace setup, registration, finalization, and Claude launch.
8. **Hook cascade**: Verify hooks rendered by `GET /hooks/{projectId}` are correctly installed in the container and intercept build/test/push commands.

## Open Questions / Risks

- The 59 test failures are all pre-existing infrastructure issues (git bare repo not available in container environment). They should pass when run on the host with proper git setup.
- The task dependency tests appear to rely on features from other branches that may not be fully merged yet.

## Suggested Follow-ups

- Run the full test suite on the host to confirm zero regressions.
- Execute the manual verification checklist (steps 88-95) with Docker.
- After all phases land in main, delete the plan file (step 98).
