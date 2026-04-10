# Debrief 0124 -- Phase 5 agents query review fixes

## Task Summary
Fix 5 review findings in `server/src/queries/agents.ts`: export AgentRow, add union types for mode/status, add input validation in register, document getAll unscoped path, document getByToken token exposure.

## Changes Made
- **server/src/queries/agents.ts** -- Exported AgentRow type; added AgentStatus and AgentMode union types; derived VALID_STATUSES/VALID_MODES from union types; changed RegisterOpts.mode to AgentMode; changed updateStatus status param to AgentStatus; added name/projectId length validation in register; added JSDoc on getAll and getByToken.

## Design Decisions
- Kept VALID_STATUSES runtime check as defense-in-depth even though the type now enforces valid values at compile time, per plan instructions.
- Did not modify callers in routes/agents.ts or test files -- those have pre-existing argument count errors unrelated to this change.

## Build & Test Results
- `npx tsc --noEmit 2>&1 | grep 'queries/agents.ts'` returns no output (no errors in the target file).
- Pre-existing errors in routes/agents.ts and agents.test.ts remain (wrong argument counts, missing projectId params) -- these are out of scope.

## Open Questions / Risks
- routes/agents.ts line 113 calls updateStatus with 3 args instead of 4 (missing projectId). This was pre-existing but the AgentStatus type change means the `string` status arg now also has a type mismatch. This needs a separate fix.

## Suggested Follow-ups
- Fix routes/agents.ts callers to pass projectId and cast status appropriately.
- Fix agents.test.ts to match current function signatures.
