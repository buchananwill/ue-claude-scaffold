# Debrief 0030 -- Decomposition Review Cycle 2 Fixes

## Task Summary

Fix review findings from decomposition review cycle: unused imports, incorrect synced flag logic, raw reply.code() usage, and missing seedBranch config read in launch.sh.

## Changes Made

- **server/src/routes/tasks.ts** -- Removed unused imports of `compositionQ`, `agentsQ`, and `projectsQ`.
- **server/src/tasks-validation.ts** -- Changed `synced = true` to only set when `syncResult.ok` is truthy, preventing false positive sync status on failure.
- **server/src/routes/agents.ts** -- Replaced raw `reply.code(400).send({...})` with `reply.badRequest(...)` in the `/agents/:name/sync` handler. Left the 422 as-is since Fastify sensible has no built-in helper for that status code.
- **launch.sh** -- Added `PROJECT_SEED_BRANCH` reads from both project config and legacy config sections. Used it as the default for `ROOT_BRANCH` computation instead of hardcoding `docker/${PROJECT_ID}/current-root`.

## Design Decisions

- The 422 response was left as raw `reply.code(422).send(...)` since `@fastify/sensible` does not provide a `.unprocessableEntity()` helper, and the existing format already matches Fastify's error shape.

## Build & Test Results

- `npm run build` -- SUCCESS (clean)
- `bash -n launch.sh` -- SUCCESS (valid syntax)

## Open Questions / Risks

None.

## Suggested Follow-ups

None.
