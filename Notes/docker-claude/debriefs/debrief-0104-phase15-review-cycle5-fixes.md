# Debrief 0104 -- Phase 15 Review Cycle 5 Fixes

## Task Summary
Fix four WARNING-level review findings from cycle 5 of Phase 15 (Decompose status.sh).

## Changes Made
- **server/src/queries/messages.ts**: Extracted `buildWhere` helper to deduplicate the `conditions.length > 0 ? and(...conditions) : undefined` pattern across 3 call sites. Added `type SQL` import from drizzle-orm. Applied default limit of 500 to the polling path when `opts.limit` is omitted.
- **server/src/routes/status.test.ts**: Added 3 tests for taskLimit rejection: `taskLimit=0`, `taskLimit=1.5`, `taskLimit=-1` all expect 400.
- **status.sh**: Narrowed the safety comment at line 131-133 to correctly state that only agent names are validated server-side, and that printf '%s' quoting handles arbitrary text in other fields.

## Design Decisions
- The polling path default limit of 500 matches the paging path's upper bound, providing consistency.
- `buildWhere` is a module-local function (not exported) since it is only used within messages.ts.

## Build & Test Results
- `npm run build`: SUCCESS
- `npx tsx --test src/routes/status.test.ts`: 13/13 passed
- `bash -n status.sh`: SUCCESS

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
