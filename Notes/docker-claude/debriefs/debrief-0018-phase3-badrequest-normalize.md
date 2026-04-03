# Debrief 0018 -- Phase 3: Normalize reply.badRequest for unknown-project errors

## Task Summary

Replace four occurrences of manual `reply.code(400).send({ statusCode, error, message })` with the idiomatic `reply.badRequest(message)` pattern from `@fastify/sensible`. This normalizes the 400 error format across routes.

## Changes Made

- **server/src/routes/tasks.ts** -- Replaced three manual 400 responses with `reply.badRequest(...)`:
  - POST /tasks (line ~76): unknown project during sourcePath validation
  - POST /tasks/batch (line ~279): unknown project during batch sourcePath validation
  - PATCH /tasks/:id (line ~488): unknown project during patch sourcePath validation
- **server/src/routes/sync.ts** -- Replaced one manual 400 response with `reply.badRequest(...)`:
  - POST /sync/plans (line ~30): unknown project lookup

## Design Decisions

- Used `reply.badRequest(message)` which is the standard pattern already established elsewhere in these files (e.g., tasks.ts line ~161).
- One remaining `reply.code(400).send(...)` exists in agents.ts but was not in scope for this fix.

## Build & Test Results

- Typecheck: PASS (npx tsc --noEmit)
- build.test.ts: 17 passed, 0 failed
- tasks.test.ts: All visible tests passed (25 + 18 dependency tests); runner timed out at 120s during later tests but no failures observed

## Open Questions / Risks

- The agents.ts file has one remaining manual 400 pattern at line 172 -- may warrant a separate cleanup.

## Suggested Follow-ups

- Normalize agents.ts reply.code(400) pattern to use reply.badRequest as well.
