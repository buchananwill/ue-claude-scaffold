# Debrief 0009 -- Review Cycle 5 Final Fixes

## Task Summary

Apply the five fixes identified in the Phase 1 review cycle 5 consolidated findings. These are the final review fixes for the multi-project support work.

## Changes Made

- **server/src/index.ts** -- Fixed single-project startup log to use `config.resolvedProjects[singleId]?.name` instead of `config.project.name`, which would default to 'UnnamedProject' when a `projects` block is present.
- **server/src/routes/projects.ts** -- Added `engineVersion` character-set validation (`/^[a-zA-Z0-9._+-]+$/`) in both POST and PATCH handlers, after the existing type/length check. Also added plugin opts documentation comment.
- **server/src/routes/ubt.ts** -- Threaded `request.projectId` through all `ubtQ.*` calls in the acquire, release, and status handlers. Updated `clearLockAndPromote` to accept a `projectId` parameter (defaulting to 'default' for backward compatibility with the sweep timer).
- **server/src/routes/build.ts** -- Added trust assumption documentation comment near the `x-agent-name` header read in the `/build` endpoint.

## Design Decisions

- `sweepStaleLock` still uses the default projectId since it runs from a global timer without request context. A proper fix would sweep all projects, but that is out of scope for this fix set.
- The trust assumption comment was added only to the `/build` endpoint handler (not `/test`) since the instructions pointed to the specific location around line 240.

## Build & Test Results

- `npm run build` and `npm run typecheck`: both pass cleanly.
- Tests: 29/29 pass for projects and UBT route test suites. No regressions.

## Open Questions / Risks

- The `sweepStaleLock` function only sweeps the 'default' project. Multi-project deployments should sweep all project locks.

## Suggested Follow-ups

- `tx as any` casts across agents.ts, coalesce.ts, etc. (20+ sites) -- requires new type infrastructure for Drizzle transactions.
- `row as any` snake_case fallbacks in tasks.ts -- migration artifact from before Drizzle, should be cleaned up.
- `sweepStaleLock` should iterate all project IDs to sweep stale locks across all projects.
