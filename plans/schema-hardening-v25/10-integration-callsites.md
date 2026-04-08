# Phase 10: Integration — remaining callsites

Every remaining caller of a renamed or removed query function must be updated. After this phase, `npm run typecheck` should pass across the whole server codebase except for test files (which are updated in Phase 12).

## Files

- `server/src/git-utils.ts` (modify)
- `server/src/routes/build.ts` (modify)
- `server/src/routes/tasks-claim.ts` (modify)
- `server/src/routes/teams.ts` (modify)
- Any other file surfaced by the typecheck sweep in step 1 below

## Work

1. Run `cd server && npm run typecheck` and collect the full error list. Expect errors from: `git-utils.ts` (uses `getActiveNames`), `routes/build.ts` (uses `getProjectId` and `getWorktreeInfo`), `routes/tasks-claim.ts` (uses `getWorktreeInfo` and `getProjectId`), `routes/teams.ts` (team_members schema change plus removed operator room-member), possibly others. The audit scratch file from Phase 1 should already list most of these.
2. For every caller of a function that now takes `projectId`, pass `request.projectId` from the Fastify request. Where the caller is not HTTP-scoped (e.g. `git-utils.ts` is invoked from multiple paths), trace the call chain upward and add a `projectId: string` parameter at each level until you reach an HTTP handler that has `request.projectId`. Do not fall back to `'default'`.
3. For every caller of `agentsQ.getProjectId(db, name)` (which is now gone), replace with `request.projectId` from the Fastify request. If the caller is receiving the agent name as a parameter and needs both the project and the UUID, replace the single call with `agentsQ.getByName(db, request.projectId, name)` and read `agent.id` and `agent.projectId` from the returned row.
4. For every caller that passed an agent name string to a query that now takes a UUID (e.g. `tasksLifecycleQ.releaseByAgent`, `coalesceQ.pausePumpAgents`, `ubtQ.*`, `roomsQ.addMember`), add a `getByName` lookup at the call site to convert the name to a UUID before the call. If the caller already has the agent row from a prior lookup, reuse it.
5. `server/src/git-utils.ts` — `getActiveNames` now requires `projectId`. `git-utils.ts:190` is the call site. Trace upward: find every function in `git-utils.ts` that transitively reaches line 190, add a `projectId: string` parameter to each, and propagate from the HTTP caller. Do not default to `'default'`.
6. `server/src/routes/build.ts` — line 119 calls `agentsQ.getProjectId(getDb(), agentName)`. Replace with `request.projectId`. Line 178 calls `agentsQ.getWorktreeInfo(getDb(), agentName)` — rewrite to `getWorktreeInfo(getDb(), request.projectId, agentName)`.
7. `server/src/routes/tasks-claim.ts` — line 47 calls `agentsQ.getWorktreeInfo(db, agent)` — rewrite to `getWorktreeInfo(db, request.projectId, agent)`. Line 66 calls `agentsQ.getProjectId(db, agent)` — replace with `request.projectId`. Rename the local variable if `agentProjectId` is used downstream, so the meaning stays obvious.
8. `server/src/routes/teams.ts` — any call to `team_members` that passed an agent name now needs a UUID. Resolve names via `agentsQ.getByName(db, request.projectId, name)` before insert. The team registration flow and any member add/remove endpoints need this treatment.
9. Re-run `cd server && npm run typecheck` after each file edit and keep going until it passes for non-test files. Test files (`*.test.ts`) will still have errors; those are Phase 12's concern. Use `tsc --noEmit` with a targeted include if needed to exclude tests from this run, or just scan the error output for `.test.ts` prefixes and ignore them for now.
10. Commit. Message: `Phase 10: Update remaining callsites for scoped queries and UUID agent references`.

## Acceptance criteria

- `cd server && npm run typecheck` has zero errors in non-test files. Errors in `*.test.ts` files are still present and are addressed in Phase 12.
- No file under `server/src/` (excluding tests) references `agentsQ.getProjectId`, `agentsQ.hardDelete`, `agentsQ.deleteAll`, or any of the old agent-name string parameters on task/file/coalesce/ubt/room functions.
- `git-utils.ts:190`'s caller chain threads a `projectId` all the way from the HTTP handler.
- Commit exists.
