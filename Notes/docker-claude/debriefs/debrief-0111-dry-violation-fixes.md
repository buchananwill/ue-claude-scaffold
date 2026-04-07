# Debrief 0111 -- DRY Violation Fixes

## Task Summary

Fix 4 DRY violations identified by the decomposition reviewer:
1. W1: Extract port-reading into `_read_server_port` shared helper in validators.sh
2. W2: Refactor POST /teams to use `createWithRoom` from queries/teams.ts
3. W3: Source compose-detect.sh in launch-team.sh instead of inline detection
4. W4: Extract `checkCanCoalesce` helper in coalesce.ts

## Changes Made

- **scripts/lib/validators.sh** -- Added `_read_server_port` function that reads port from scaffold.config.json with jq fallback to 9100, validates range 1-65535, and echoes the result.
- **status.sh** -- Added `source scripts/lib/validators.sh`; replaced inline port-reading block with `_read_server_port "$SCRIPT_DIR"` call.
- **stop.sh** -- Replaced inline port-reading block with `_read_server_port "$SCRIPT_DIR"` call (already sourced validators.sh).
- **scripts/ingest-tasks.sh** -- Added `source lib/validators.sh`; replaced inline port-reading with `_read_server_port "$SCRIPT_DIR/.."` (parent dir since script lives in scripts/).
- **server/src/routes/teams.ts** -- Replaced inline team+room creation logic (create, addMember, createRoom, addMember loops) with single `teamsQ.createWithRoom(tx, {...})` call. Kept the existing-team cleanup (deleteRoom/deleteTeam) before the main creation.
- **scripts/launch-team.sh** -- Replaced inline docker compose detection (COMPOSE_CMD array + two if/elif checks) with `source compose-detect.sh` + `_detect_compose || exit 1`.
- **server/src/routes/coalesce.ts** -- Extracted `checkCanCoalesce(db, projectId)` async function returning `{canCoalesce, activeTaskCount, pumpAgents, allPumpIdle}`. Called from status endpoint, drain poll loop, and drain final check instead of repeating the pattern inline.

## Design Decisions

- `_read_server_port` echoes the port rather than setting a global, keeping it composable via command substitution (`port="$(_read_server_port dir)"`).
- In coalesce.ts, named the final-check variable `finalCheck` instead of `final` to avoid the reserved word.
- The status endpoint still calls `agentsQ.getAll` a second time for the per-agent detail enrichment (ownedFiles, activeTasks). This is intentional -- `checkCanCoalesce` returns the raw pump agent subset for the coalesce predicate, while the status endpoint needs the full enriched list.

## Build & Test Results

- `npm run build` in server/: SUCCESS (clean compile)
- `npx tsx --test src/routes/coalesce.test.ts`: 20/20 pass
- `npx tsx --test src/routes/teams.test.ts`: 23/23 pass
- `bash -n` syntax check on status.sh, stop.sh, launch-team.sh, ingest-tasks.sh: all pass

## Open Questions / Risks

- None. All changes are mechanical DRY extractions with existing test coverage.

## Suggested Follow-ups

- The status endpoint in coalesce.ts calls `agentsQ.getAll` twice (once inside `checkCanCoalesce`, once for the enriched agent list). A future optimization could pass the agent rows from checkCanCoalesce into the enrichment loop, but this would change the helper's return type and was out of scope.
