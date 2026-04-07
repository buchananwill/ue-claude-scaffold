# Debrief 0047 -- Task Filter Review Cycle 3 Fixes

## Task Summary
Apply four review findings from Phase 1 Review Cycle 3: merge duplicate imports, validate status in DELETE /tasks, reorder priority empty-segment check, and add cardinality cap tests.

## Changes Made
- **server/src/routes/tasks.ts** -- Merged duplicate `tasks-replan.js` imports into a single statement (STYLE-B1).
- **server/src/routes/tasks.ts** -- Added VALID_TASK_STATUSES validation to DELETE /tasks before the claimed/in_progress guard (SAFETY-B1).
- **server/src/routes/tasks.ts** -- Reordered priority filter checks so empty-segment guard runs before non-integer guard, matching status/agent pattern (SAFETY-W1).
- **server/src/routes/tasks.test.ts** -- Added three tests for cardinality cap (51 values for status, agent, priority each assert HTTP 400 with "Too many") (CORRECTNESS-W1).

## Design Decisions
- For the cardinality tests, status uses 51 copies of 'pending' (a valid status) to ensure the cardinality check triggers before the validation check. Agent and priority use unique valid values.

## Build & Test Results
- Build: SUCCESS (`npm run build`)
- Tests: 44 passed in suite 1 (all task CRUD/filter tests including 3 new cardinality tests). Suite 2 failures are pre-existing git config issues in the container environment, unrelated to changes.

## Open Questions / Risks
- None for these changes.

## Suggested Follow-ups
- None.
