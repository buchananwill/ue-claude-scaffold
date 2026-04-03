# Debrief 0019 -- Phase 3: Normalize reply.unprocessableEntity for 422 errors

## Task Summary
Replace manual `reply.code(422).send({...})` patterns with `reply.unprocessableEntity('...')` in tasks.ts (2 locations) and sync.ts (2 locations). The 409 response in sync.ts was explicitly excluded from this change.

## Changes Made
- **server/src/routes/tasks.ts** -- Replaced two `reply.code(422).send(...)` calls with `reply.unprocessableEntity(...)` for sourcePath validation in single and batch task creation.
- **server/src/routes/sync.ts** -- Replaced two `reply.code(422).send(...)` calls with `reply.unprocessableEntity(...)` for missing bareRepoPath and project.path config checks.

## Design Decisions
- Used `reply.unprocessableEntity(message)` from `@fastify/sensible`, consistent with existing usage elsewhere in the codebase.
- Did not touch the 409 response at sync.ts line ~56 as instructed.

## Build & Test Results
- Typecheck: PASS (npx tsc --noEmit)
- Tests: All 29 tasks tests pass

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
