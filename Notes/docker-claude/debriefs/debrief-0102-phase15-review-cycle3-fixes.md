# Debrief 0102 -- Phase 15 Review Cycle 3 Fixes

## Task Summary
Fix all BLOCKING and WARNING findings from the Phase 15 cycle 3 review of the status.sh decomposition (GET /status endpoint and status.sh shell script).

## Changes Made
- **server/src/routes/status.ts**: Fixed `since=0` coercion bug (B1: `parsed || undefined` -> `parsed`), removed project filter bypass for 'default' (B2: pass projectId unconditionally), added Math.floor to taskLimit (W7), added explanatory comment for TaskRow cast (W1), added comment for slice safety belt (W3).
- **server/src/routes/status.test.ts**: Rewrote "since=0" test to verify polling mode returns all messages instead of asserting paging-mode equivalence (B1).
- **server/src/queries/messages.ts**: Added limit support to polling path so the query layer respects the limit parameter in both modes (W3).
- **status.sh**: Renamed `_SHOW_PROJECT` to `SHOW_PROJECT` (W4), replaced `printf '%b\n'` with split format strings using `%b` for color and `%s` for jq-extracted data (W5), added `--since` validation (W6), added comment about CURSOR global mutation (W8).

## Design Decisions
- W1: Kept the `as unknown as TaskRow` cast because Drizzle's inferred select type uses camelCase required fields while TaskRow declares snake_case as required. Added a comment explaining why.
- W2: No change needed -- statusPlugin already uses bare `FastifyPluginAsync` consistent with filesPlugin, searchPlugin, messagesPlugin, and other plugins that don't need config opts.
- W3: Chose to fix at both layers: added limit to the query polling path AND kept the slice as a defense-in-depth comment.
- W5: Split printf format strings so color escape variables use `%b` placeholders while jq-extracted user data uses `%s` placeholders, preventing escape sequence injection from message content.

## Build & Test Results
- `npm run build` in server/: SUCCESS (clean)
- `npx tsx --test src/routes/status.test.ts`: 10 passed, 0 failed
- `bash -n status.sh`: SUCCESS (valid syntax)

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
