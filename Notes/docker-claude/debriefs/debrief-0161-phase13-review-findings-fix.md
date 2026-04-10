# Debrief 0161 -- Phase 13 Review Findings Fix

## Task Summary

Fix four review findings from Phase 13: one blocking (briefPath validation in POST /teams) and three warnings (test isolation in ubt.test.ts, non-null assertion in ubt queries test, unsanitized user input in error messages).

## Changes Made

- **server/src/routes/teams.ts**: Added briefPath traversal validation (startsWith('/'), '..' rejection, BRIEF_PATH_RE check) before the transaction in POST /teams, matching the existing validation in the launch handler. Also truncated `m.agentName` to 64 chars in error messages to prevent unsanitized user input reflection.
- **server/src/routes/ubt.test.ts**: Changed `const agentIds` to `let agentIds` and added `agentIds = {}` reset at the start of beforeEach to ensure test isolation.
- **server/src/queries/ubt.test.ts**: Replaced `found.priority!` non-null assertion with an explicit `assert.notEqual(found.priority, null)` guard followed by `found.priority ?? 0`.

## Design Decisions

- For B1, validation is only applied when briefPath is not null/undefined (it is optional on POST /teams).
- For W3, used `.slice(0, 64)` consistently for all three error message sites in the member validation loop, stored in a local `safeName` variable.
- For W2, added both the runtime assertion guard AND the nullish coalesce fallback for belt-and-suspenders safety.

## Build & Test Results

- Build: SUCCESS (`npm run build`)
- Tests: 55 passed, 0 failed across ubt.test.ts, ubt queries test, and teams.test.ts

## Open Questions / Risks

None.

## Suggested Follow-ups

None.
