# Debrief 0082 -- Team Launcher Review Fixes (Phase 11 Cycle 1)

## Task Summary

Fix all review findings from Phase 11 (team launcher) cycle 1, covering blocking and warning issues across style, safety, and correctness categories.

## Changes Made

- **server/src/routes/teams.ts**: Renamed `TeamsPluginOpts` to `TeamsOpts` (Style B1). Made `config` required (Style B2). Removed `(r: any)` annotation (Style B3). Removed `teamsDir` from request body -- now derived server-side from `config.configDir` (Safety B1). Added `briefPath` validation: rejects absolute paths, `..` traversal, and invalid characters (Safety B3). Added `id` param pattern constraint (Safety W1). Sanitized error messages by stripping filesystem paths (Safety W2). Removed `if (!config)` guard since config is now required.
- **server/src/config.ts**: Added `configDir: string` field to `ScaffoldConfig`. Set it from `path.dirname(configPath)` in `loadConfig()`.
- **server/src/test-helper.ts**: Added `configDir: '/tmp'` to `createTestConfig` base config.
- **server/src/routes/teams.test.ts**: Updated all `register(teamsPlugin)` calls to pass `{ config: createTestConfig() }`.
- **server/src/team-launcher.ts**: Imported `AGENT_NAME_RE` and validate each member's `agentName` format (Safety B2). Added `role` non-empty validation (Style W3). Added duplicate-registration guard checking `teamsQ.getById()` before `createWithRoom()` (Correctness B2).
- **launch.sh**: Moved health check before team mode block (Style W1). Changed `source` to `exec` for `scripts/launch-team.sh` (Correctness B1). Removed `export -f _launch_container` (Style W2). Wrapped `AGENT_TYPE` required check to skip in team mode (Correctness B3). Guarded dynamic agent compilation to skip when `AGENT_TYPE` is empty.
- **scripts/launch-team.sh**: Rewrote to be self-contained (not relying on sourced `_launch_container` function). Inlined docker compose invocation. Used `COMPOSE_CMD` as array (Safety W3). Used process substitution for while-read loop (Correctness W2). Truncated raw server response in error output (Safety W4). Removed `teamsDir` from the server request payload.

## Design Decisions

- For `configDir`, stored it directly on `ScaffoldConfig` since `loadConfig()` already knows the resolved config path. This avoids adding a separate config-path resolution mechanism.
- For `teamsDir` derivation: `path.resolve(config.configDir, 'teams')` -- teams definitions live in a `teams/` directory alongside `scaffold.config.json`.
- For error sanitization: used a simple regex to strip filesystem paths (`/[^\s:]+`). This removes any absolute path from error messages returned to HTTP callers.
- Made `launch-team.sh` detect docker compose independently since it's now `exec`-ed (cannot inherit shell functions).

## Build & Test Results

- TypeScript typecheck: PASS
- TypeScript build: PASS
- Shell script syntax validation (bash -n): PASS for launch.sh, launch-team.sh, setup.sh, status.sh, stop.sh
- teams.test.ts: 16 passed, 0 failed
- team-launcher.test.ts: 11 passed, 0 failed
- config.test.ts: 17 passed, 0 failed

## Open Questions / Risks

- The `BRIEF_PATH_RE` regex allows forward slashes for nested paths but not other special characters. If brief filenames need spaces or other characters, the regex would need loosening.
- The `launch-team.sh` script re-detects docker compose independently. If the detection logic diverges from `launch.sh`, they could get out of sync.

## Suggested Follow-ups

- Consider extracting docker compose detection into a shared `scripts/lib/detect-compose.sh` to avoid duplication.
- Add integration tests for the `POST /teams/:id/launch` endpoint with the new `briefPath` validation.
