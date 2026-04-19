# Debrief 0174 - Safety Review Fixes for agent_type_override

## Task Summary

Fix two WARNING-level safety review findings from the Phase 2 agent_type_override work:
- W1: POST /tasks and POST /tasks/batch silently tolerate `null` for agentTypeOverride on create routes; they should return 400.
- W2: The `patch()` function in tasks-core.ts sets agentTypeOverride without validating it, so future callers that skip route-level validation could write invalid data.

## Changes Made

- **server/src/routes/tasks.ts** -- Modified the agentTypeOverride validation in POST /tasks (line ~176) and POST /tasks/batch (line ~328) to explicitly check for `null` and return 400 with the message "agentTypeOverride must be a string or omitted, not null". Previously the guard `!== undefined && !== null` simply skipped null values, allowing them to pass through silently.

- **server/src/queries/tasks-core.ts** -- Added import of `isValidAgentName` from `../branch-naming.js`. Added a self-defending guard at the top of `patch()` that validates non-null `agentTypeOverride` values against `isValidAgentName` and throws an Error if invalid. Null values (used to clear the field) pass through unimpeded.

- **server/src/routes/tasks.test.ts** -- Added two new tests: one verifying POST /tasks rejects null agentTypeOverride with 400, another verifying POST /tasks/batch rejects null agentTypeOverride with 400 (including task index in the error message).

- **server/src/queries/tasks-core.test.ts** -- Added three new tests: one verifying patch() throws on invalid agentTypeOverride, one verifying patch() allows null (clearing the field), one verifying patch() allows a valid agentTypeOverride string.

## Design Decisions

- The null rejection on create routes returns a specific, helpful error message ("must be a string or omitted, not null") rather than a generic validation error, so callers know exactly what went wrong.
- The self-defending guard in patch() throws a plain Error (not an HTTP error) since it's a query-layer function, not a route handler. Callers are responsible for catching and translating to appropriate HTTP responses.
- The patch guard only validates non-null strings; null is allowed since the PATCH route legitimately uses null to clear the field.

## Build & Test Results

- **Build**: SUCCESS (`npm run build` -- clean, no errors)
- **tasks-core tests**: 17/17 pass (3 new)
- **tasks route tests**: 61/61 pass (2 new)
- Pre-existing failure in `POST /agents/:name/sync` tests (git config issue unrelated to this work)

## Open Questions / Risks

None. The changes are minimal and well-scoped.

## Suggested Follow-ups

None.
