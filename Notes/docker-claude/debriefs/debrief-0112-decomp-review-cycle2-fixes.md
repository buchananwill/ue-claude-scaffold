# Debrief 0112 - Decomposition Review Cycle 2 Fixes

## Task Summary
Fix all findings from decomposition review cycle 2: 3 blocking issues (TOCTOU, input validation) and 5 warnings (style, safety, correctness).

## Changes Made

- **server/src/routes/coalesce.ts** (modified): B1 -- Refactored `checkCanCoalesce` to accept optional pre-fetched agent rows and return `agentRows` in its result. The `/coalesce/status` handler now uses the returned rows instead of making a second `agentsQ.getAll` call, eliminating the TOCTOU race.
- **server/src/routes/teams.ts** (modified): B2 -- Added validation of `status` query param on `GET /teams` against `VALID_STATUSES`, returning 400 for invalid values. B3 -- Added `ROLE_RE` regex and validation of each member's role format on `POST /teams`. W1 -- Merged the two consecutive `if (status !== undefined)` blocks in PATCH handler into one.
- **server/src/routes/teams.test.ts** (modified): Added tests for B2 (invalid/valid status filter on GET /teams) and B3 (invalid role characters, role exceeding 128 chars).
- **status.sh** (modified): W2 -- Replaced inline PROJECT_ID regex with `_validate_identifier` call.
- **stop.sh** (modified): W2 -- Replaced inline PROJECT_ID regex with `_validate_identifier` call.
- **scripts/lib/validators.sh** (modified): W3 -- Added `--` before filename in jq call in `_read_server_port`. W5 -- Changed port regex from `^[0-9]{1,5}$` to `^[1-9][0-9]{0,4}$` to reject leading zeros.
- **scripts/lib/curl-json.sh** (modified): W4 -- Made invalid PROJECT_ID and AGENT_NAME fatal (return 1) instead of silently omitting headers. Applied to both `_post_json` and `_get_json`.

## Design Decisions
- B1: Chose the "return agentRows from checkCanCoalesce" approach rather than the "accept pre-fetched" approach for the `/coalesce/status` handler, since it's cleaner. The function signature still accepts an optional `prefetchedAgents` parameter for callers that already have the data.
- W4: Applied the fatal-on-invalid-identifier pattern to both `_post_json` and `_get_json` for consistency, even though the instructions only mentioned `_post_json`.

## Build & Test Results
- Build: SUCCESS (`npm run build`)
- Coalesce tests: 20/20 passed
- Teams tests: 27/27 passed
- Shell syntax: all 4 scripts pass `bash -n`

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
