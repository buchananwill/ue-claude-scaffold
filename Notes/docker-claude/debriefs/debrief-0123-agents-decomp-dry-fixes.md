# Debrief 0123 -- agents decomp DRY fixes

## Task Summary
Fix two decomposition review findings in `server/src/queries/agents.ts`: extract a repeated WHERE clause helper and DRY up softDelete/stopAgent by delegating to updateStatus.

## Changes Made
- **server/src/queries/agents.ts** -- Added `byProjectAndName` file-local helper; replaced 5 inline `and(eq(...), eq(...))` calls with the helper; rewrote `softDelete` and `stopAgent` to delegate to `updateStatus`.

## Design Decisions
- Kept `byProjectAndName` as a plain function (not exported) since it is file-local only.
- `softDelete` and `stopAgent` now go through the `updateStatus` validation gate, which is the intended benefit per the review finding.

## Build & Test Results
- `npx tsc --noEmit | grep queries/agents.ts` returns nothing (clean).
- Full typecheck shows pre-existing errors only in `ubt.ts` (unrelated).
- Agent route tests have pre-existing timeout failures (unrelated to this change).

## Open Questions / Risks
None -- straightforward mechanical refactor.

## Suggested Follow-ups
None.
