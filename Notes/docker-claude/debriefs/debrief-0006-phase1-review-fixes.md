# Debrief 0006 -- Phase 1 Review Fixes

## Task Summary

Applied 19 review findings (BLOCKING + WARNING) from three parallel code reviews: style, safety, and correctness. The fixes targeted the projects CRUD feature added in the previous phase, plus a systemic issue where route handlers bypassed the project-id validation plugin.

## Changes Made

- **server/src/schema/tables.ts** -- Fixed comment numbering: projects is now 14, teamMembers is now 15.
- **server/src/queries/projects.ts** -- (1) Replaced dynamic `await import()` in `hasReferencingData` with static top-level imports of all table symbols. (2) Changed `update()` set type from `Record<string, unknown>` to `Partial<typeof projects.$inferInsert>`. (3) Changed `seedFromConfig` to accept `Array<{ id: string; name?: string }>` instead of `string[]`, returning `{ inserted, skipped, invalid }` with invalid IDs separated.
- **server/src/routes/projects.ts** -- (1) Added `Record<never, never>` generic to `FastifyPluginAsync`. (2) Added `isValidProjectId` checks to GET, PATCH, DELETE `:id` handlers. (3) Added PATCH body validation (name length, seedBranch pattern, timeout bounds).
- **server/src/routes/projects.test.ts** -- (1) Replaced `it('setup')` with `before()` hook. (2) Replaced `(p: any)` with `(p: { id: string })`. (3) Added empty-string ID test case.
- **server/src/routes/health.ts** -- Replaced raw `request.headers['x-project-id']` with `request.projectId`.
- **server/src/routes/health.test.ts** -- (1) Moved ctx initialization to `before()` hook. (2) Added test for valid x-project-id returning projectName. (3) Added test for unknown x-project-id omitting projectName.
- **server/src/config.ts** -- Added `engineVersion` merge in `getProject()`: when dbRow has a non-null engineVersion, it overrides the JSON engine version.
- **server/src/plugins/project-id.ts** -- (1) Removed `projectRecord` declaration and decoration (dead code). (2) Wrapped plugin with `fastify-plugin` so the preHandler hook propagates to sibling plugins.
- **server/src/index.ts** -- Changed `seedFromConfig` call to pass `Array<{ id, name }>` entries with names from resolved config. Added error-level logging for invalid project IDs.
- **server/src/routes/agents.ts** -- Replaced raw header read with `request.projectId`.
- **server/src/routes/sync.ts** -- Replaced raw header read with `request.projectId`.
- **server/src/routes/coalesce.ts** -- Replaced 3 raw header reads with `request.projectId`.
- **server/src/routes/files.ts** -- Replaced raw header read with `request.projectId`.
- **server/src/routes/tasks.ts** -- Replaced 3 raw header reads with `request.projectId`.

## Design Decisions

- **fastify-plugin wrapping for project-id**: The original `projectIdPlugin` was not wrapped with `fastify-plugin`, meaning its `preHandler` hook was encapsulated and invisible to sibling route plugins. This made `request.projectId` always `'default'` in practice. Wrapping with `fastify-plugin` was necessary to make item 8 (replace header reads with `request.projectId`) work correctly. This is a slightly larger change than the plan specified, but without it the plugin's validation would remain bypassed.
- **seedFromConfig invalid array**: Changed to return a separate `invalid` array rather than lumping invalid IDs into `skipped`, per item 12. The caller in `index.ts` logs invalid IDs at error level.

## Build & Test Results

- **Build**: SUCCESS (`npm run build` and `npm run typecheck` both clean)
- **Tests**: 30/30 pass across `projects.test.ts`, `projects.queries.test.ts`, `health.test.ts`
- **Regression check**: `coalesce.test.ts` (14/14 pass), `files.test.ts` (4/4 pass). Pre-existing failures in `agents.test.ts` git-sync tests are unrelated (no bare repo in container).

## Open Questions / Risks

- The `fastify-plugin` wrapping of `projectIdPlugin` is a behavioral change: the preHandler hook now fires for ALL routes, not just those in the same encapsulation context. This is correct (matches the plugin's intent), but any route that previously relied on `request.projectId` being `'default'` without sending the header will now see validated behavior.
- The `tasks.ts` GET endpoint previously fell back to `undefined` for projectId when no header/query was sent: `project || ((request.headers['x-project-id'] as string) || undefined)`. It now uses `project || request.projectId`, which falls back to `'default'` instead of `undefined`. If the query layer treats `undefined` differently from `'default'`, this could be a subtle behavior change.

## Suggested Follow-ups

- Add `fastify-plugin` as a direct dependency in `package.json` rather than relying on it being available transitively through `@fastify/sensible`.
- Consider adding integration tests that verify the project-id plugin's preHandler fires for routes across different plugins.
- The PATCH body validation upper bound (3600000ms = 1 hour) may be too restrictive for some UE projects; consider making it configurable.
