# Debrief 0084 -- Phase 11 Review Cycle 3 Fixes

## Task Summary

Fix all review findings from Phase 11 cycle 3 across server source, route definitions, shell scripts, and tests.

## Changes Made

- **server/src/drizzle-instance.ts** -- Removed `as any` cast; use `pgliteClient.exec()` directly for timezone SET. Introduced local `pgliteDb` variable to avoid the migrate cast.
- **server/src/team-launcher.ts** -- Added `AGENT_NAME_RE.test(teamId)` validation at the top of `loadTeamDef()`. Added `AGENT_NAME_RE.test(m.agentType)` format check for each member's agentType.
- **server/src/routes/teams.ts** -- Added `maxLength: 64` to the `id` param schema in `POST /teams/:id/launch`. Simplified VALID_STATUSES includes check to `(VALID_STATUSES as readonly string[]).includes(status)`. Replaced `briefPath.includes('..')` with segment-based `.split('/').some(s => s === '.' || s === '..')` check.
- **scripts/launch-team.sh** -- Added format validation for `_TYPE` and `_BRANCH` after jq extraction.
- **server/src/team-launcher.test.ts** -- Added test for re-launching a dissolved team (launch, dissolve, re-launch, assert success).

## Design Decisions

- Used `AGENT_NAME_RE` (already imported) for both teamId and agentType validation since the pattern `^[a-zA-Z0-9_-]{1,64}$` matches the requirements.
- The segment-based briefPath check catches both `.` and `..` segments, which is stricter than the previous substring check.

## Build & Test Results

- Server build: SUCCESS (`npm run build`)
- Shell syntax: PASS (`bash -n scripts/launch-team.sh`)
- Tests: 12 passed, 0 failed (team-launcher.test.ts)

## Open Questions / Risks

None.

## Suggested Follow-ups

None.
