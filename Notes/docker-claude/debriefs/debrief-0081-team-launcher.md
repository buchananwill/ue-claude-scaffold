# Debrief 0081: Phase 11 — Server-side Team Launch

## Task Summary

Implement Steps 57-61 of the shell decomposition plan: move team launch logic from `launch.sh` into a server-side module (`team-launcher.ts`), expose it via `POST /teams/:id/launch`, write tests, and create a thin shell script (`scripts/launch-team.sh`) that curls the new endpoint and launches containers from the response.

## Changes Made

- **server/src/team-launcher.ts** (created): Core module exporting `launchTeam()`, `loadTeamDef()`, and `validateBriefOnSeedBranch()`. Validates brief on seed branch via `git cat-file`, loads and validates team JSON (leader count, duplicate names), registers team+room via `createWithRoom`, posts brief as first room message, sets up agent branch refs via `ensureAgentBranch`, resolves hook cascade (team defaults + member overrides), returns structured launch plan.

- **server/src/team-launcher.test.ts** (created): 11 tests across 3 suites covering: brief validation (exists/missing), team def loading (valid/missing file/duplicate members/no leader), and full `launchTeam()` integration (happy path verifying DB state + branch refs, missing brief, missing team file, duplicate members, hook resolution cascade).

- **server/src/routes/teams.ts** (modified): Added `POST /teams/:id/launch` route accepting `{projectId, briefPath, teamsDir}`. Updated plugin signature to accept optional `ScaffoldConfig`. The route resolves the project, delegates to `launchTeam()`, and returns the launch plan.

- **server/src/routes/index.ts** (unchanged): `teamsPlugin` already exported.

- **server/src/index.ts** (modified): Changed `teamsPlugin` registration to pass `{ config }`.

- **scripts/launch-team.sh** (created): Thin shell script that curls `POST /teams/:id/launch`, validates the response, then iterates members to call `_launch_container` (exported from launch.sh). Preserves the 10s delay between leader and non-leader launches.

- **launch.sh** (modified): Replaced the 165-line team block (lines 488-653) with an 8-line delegation that exports necessary variables/functions and sources `scripts/launch-team.sh`.

## Design Decisions

1. **`launchTeam` takes explicit deps**: Rather than reaching into singletons, the function takes `db`, `project`, `teamsDir` as parameters for testability. The route handler resolves these from Fastify context.

2. **`teamsDir` is a required body param**: The server doesn't know where team definition files live on the host filesystem, so the shell caller passes it. This avoids coupling server config to filesystem layout.

3. **Hook resolution moved server-side**: The cascading hook resolution (team defaults + member overrides) is now in `team-launcher.ts`, replacing the shell-based `resolve_hooks` function for team mode. System/project/CLI overrides remain in the shell layer since the server doesn't have those contexts.

4. **Leader-first ordering**: The server sorts members leader-first in the response, matching the original shell behavior. The shell script respects this ordering and inserts the 10s delay after the leader.

5. **Optional config on teams plugin**: Made `config` optional (`config?: ScaffoldConfig`) so existing tests that register `teamsPlugin` without config continue to work. The launch route returns 500 if config is missing.

## Build & Test Results

- **Typecheck**: PASS (`npm run typecheck`)
- **Build**: PASS (`npm run build`)
- **New tests**: 11/11 pass (`src/team-launcher.test.ts`)
- **Existing teams tests**: 16/16 pass (`src/routes/teams.test.ts`)
- **Shell syntax**: `bash -n` passes for both `launch.sh` and `scripts/launch-team.sh`

## Open Questions / Risks

- The `teamsDir` parameter means the server trusts the caller's filesystem path. In production this is only called from the host's `launch.sh`, but the endpoint is technically accessible to anyone who can reach the server. Consider restricting `teamsDir` to a configured allowed path if security hardening is needed.
- The shell script uses `source` (not `exec`) to inherit `_launch_container` and all env vars from `launch.sh`. This means the team script runs in the same process. If `exec` semantics are preferred, the function would need to be redefined or the script would need to be self-contained.

## Suggested Follow-ups

- Add route-level tests for `POST /teams/:id/launch` using the Fastify inject pattern (would require mocking git operations).
- Consider adding an agent collision check to `launchTeam()` (currently only the old shell code did this).
- Consider moving the 10s leader delay into the server response as a `leaderDelayMs` field for configurability.
