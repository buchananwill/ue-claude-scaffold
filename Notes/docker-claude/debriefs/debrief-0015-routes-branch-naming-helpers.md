# Debrief 0015: Update Server Routes to Use Branch-Naming Helpers

## Task Summary
Phase 3 of the server-multi-tenancy plan: replace all inline branch name constructions
(`'docker/current-root'` fallbacks and `` `docker/${name}` `` template literals) in server
route files with the `seedBranchFor()` and `agentBranchFor()` helpers from
`server/src/branch-naming.ts`. Also drop the legacy `config.tasks?.seedBranch` fallback
chain everywhere.

## Changes Made
- **server/src/branch-naming.ts**: Widened `seedBranchFor` parameter type from
  `Pick<ProjectRow, 'seedBranch'>` to `{ seedBranch?: string | null }` so it accepts
  both `ProjectRow` (null) and `MergedProjectConfig` (undefined). Removed unused
  `ProjectRow` import.
- **server/src/routes/agents.ts**: Added import of helpers; replaced `project.seedBranch ?? 'docker/current-root'` with `seedBranchFor()`; replaced `` `docker/${name}` `` with `agentBranchFor()`.
- **server/src/routes/build.ts**: Added import; replaced `'docker/current-root'` default in `syncWorktree()` with project-aware `seedBranchFor()` call.
- **server/src/routes/sync.ts**: Added import; replaced seed branch fallback chain and inline agent branch construction with helpers.
- **server/src/routes/tasks.ts**: Added import; replaced all 4 locations (POST /tasks, POST /tasks with targetAgents merge, POST /tasks/batch, PATCH /tasks/:id) with helper calls.
- **server/src/routes/tasks-files.ts**: Added import; replaced `blockReasonsForTask` seed branch fallback with `seedBranchFor()`.
- **server/src/routes/tasks-lifecycle.ts**: Added imports for `projectsQ`, `getProject`, and `seedBranchFor`; rewrote the reset handler to resolve project from the task's `projectId` instead of using `config.server.bareRepoPath` / `config.project.path` directly.
- **server/src/routes/tasks-claim.ts**: Added import; replaced both `config.tasks?.seedBranch ?? 'docker/current-root'` fallbacks with `seedBranchFor()`.
- **server/src/routes/agents.test.ts**: Updated branch names from `docker/current-root` to `docker/default/current-root`, `docker/test-agent` to `docker/default/test-agent`; removed `tasks: { seedBranch: ... }` from test config.
- **server/src/routes/build.test.ts**: Updated expected branch name assertions from `docker/current-root` to `docker/default/current-root`.
- **server/src/routes/tasks.test.ts**: Updated branch names from `docker/current-root` to `docker/default/current-root`, agent branches to `docker/default/agent-1` etc.; removed `tasks: { seedBranch: ... }` from test config.

## Design Decisions
- Widened `seedBranchFor` signature to use `{ seedBranch?: string | null }` inline type
  instead of `Pick<ProjectRow, ...>` to resolve the `undefined` vs `null` type mismatch
  between `MergedProjectConfig` and `ProjectRow`. This is the minimal change that makes
  both callers happy.
- In `tasks-lifecycle.ts` reset handler, wrapped the project resolution in a try/catch
  that silently skips sourcePath validation on unknown projects, matching the pattern
  already used in `tasks-files.ts`.

## Build & Test Results
- Typecheck: PASS (`npx tsc --noEmit`)
- agents.test.ts: 22 passed, 0 failed
- build.test.ts: 15 passed, 0 failed
- tasks.test.ts: 76 passed, 0 failed
- branch-naming.test.ts: 23 passed, 0 failed

## Open Questions / Risks
- The `projects.test.ts` file uses literal `'docker/current-root'` as seed branch values
  in DB records. These are data values, not branch resolution logic, so they were left as-is.
- The `config.tasks?.seedBranch` field still exists in the config type and is still read
  in `config.ts` line 147 to populate `getProject()` output. It is no longer consumed
  directly by any route; it flows through `ProjectConfig.seedBranch` into `seedBranchFor()`.
  A future cleanup could remove it from the config type entirely.

## Suggested Follow-ups
- Remove `config.tasks?.seedBranch` from `ScaffoldConfig` type and `loadConfig()`.
- Update `config.ts` `getProject()` to stop reading from the legacy field.
