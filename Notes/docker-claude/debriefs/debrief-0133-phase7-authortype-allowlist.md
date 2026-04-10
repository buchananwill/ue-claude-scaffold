# Debrief 0133 -- Phase 7: authorType allowlist validation

## Task Summary
Add a runtime allowlist guard at the top of `sendMessage` in `server/src/queries/chat.ts`, before the existing cross-field checks, to reject invalid `authorType` values.

## Changes Made
- **server/src/queries/chat.ts** -- Added `VALID_AUTHOR_TYPES` const array and an `includes` check that throws on invalid values, placed before the existing agent/authorAgentId cross-field validation.

## Design Decisions
- Used `as const` assertion on the array and a cast on the argument to satisfy TypeScript's strict `includes` typing, matching the pattern specified in the task.

## Build & Test Results
- Build succeeds for chat.ts (no errors from that file). Pre-existing errors in other files (tasks-claim.ts, tasks-lifecycle.ts, etc.) are unrelated and outside scope.

## Open Questions / Risks
- None.

## Suggested Follow-ups
- None.
