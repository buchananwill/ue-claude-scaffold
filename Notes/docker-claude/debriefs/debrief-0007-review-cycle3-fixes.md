# Debrief 0007 -- Phase 1 Review Cycle 3 Fixes

## Task Summary

Fix all issues from the Phase 1 review cycle 3 consolidated findings: a blocking correctness issue (getProject() DB merge never invoked in production routes), style cleanups (projectsPlugin generics, formatAgent typing, stale comment), safety improvements (POST /projects field validation, multi-value header guard), and a documentation comment for project-id plugin.

## Changes Made

- **server/src/routes/build.ts**: Added `projectsQ` import; updated `resolveProjectForAgent` to fetch DB row and pass it to `getProject()` so timeout overrides from DB are applied.
- **server/src/routes/tasks.ts**: Added `projectsQ` import; updated all four `getProject()` call sites (POST /tasks sourcePath validation, POST /tasks targetAgents merge, POST /tasks/batch sourcePath validation, PATCH /tasks/:id sourcePath validation) to fetch and pass DB rows.
- **server/src/routes/tasks-claim.ts**: Added `projectsQ` import; updated `validateSourcePathForClaim` to fetch DB row once and pass to both `getProject()` calls, so seedBranch overrides are respected.
- **server/src/routes/tasks-files.ts**: Added `projectsQ` import; updated `blockReasonsForTask` to fetch DB row and pass to `getProject()`.
- **server/src/routes/sync.ts**: Added `projectsQ` import; updated POST /sync/plans to fetch DB row for seedBranch resolution.
- **server/src/routes/agents.ts**: Added `projectsQ` import; updated POST /agents/:name/sync to fetch DB row. Fixed `formatAgent` to use typed `AgentRow` parameter and removed snake_case fallbacks.
- **server/src/routes/projects.ts**: Removed `Record<never, never>` generic from plugin type. Replaced stale comment. Added field validation to POST /projects (name, seedBranch, engineVersion, buildTimeoutMs, testTimeoutMs).
- **server/src/plugins/project-id.ts**: Added `Array.isArray` guard for multi-value header. Added comment explaining format-only validation choice.

## Design Decisions

- For the tasks.ts POST /tasks route, the DB row fetch for sourcePath validation uses `getDb()` directly (via `projectsQ.getById(getDb(), ...)`) rather than the local `db` variable, because `db` is declared later in the function scope. The targetAgents and batch calls use the already-declared `db`.
- In tasks-claim.ts `validateSourcePathForClaim`, the DB row is fetched once and reused for both `getProject()` calls to avoid duplicate queries.

## Build & Test Results

- **Build**: SUCCESS (`npm run build` and `npm run typecheck` both clean)
- **Tests**: 30 passed, 0 failed (projects.test.ts, projects routes, health.test.ts)

## Open Questions / Risks

- The `formatAgent` change removes snake_case fallbacks. If any code path still returns snake_case rows from the DB (e.g. raw SQL queries), those would break. Based on the schema using Drizzle ORM with camelCase column aliases, this should be safe.

## Suggested Follow-ups

- Consider adding integration tests that verify DB timeout overrides actually flow through to the build/test execution timeout.
- The `tasks-files.ts` `blockReasonsForTask` function also has a `getProject` call that now passes the DB row -- could benefit from a test verifying seedBranch override in block-reason logic.
