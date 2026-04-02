# Debrief 0005 - Projects Table and CRUD

## Task Summary

Implement Phase 1 of the "Server Multi-Tenancy and Project-Namespaced Branches" plan. This phase adds a `projects` table to the DB, seeds it from JSON config on startup, provides full CRUD endpoints, refactors `getProject()` to merge DB and JSON config, updates the health endpoint, and simplifies the JSON config example.

## Changes Made

- **server/src/schema/tables.ts** - Added `projects` table (id PK, name, engine_version, seed_branch, build_timeout_ms, test_timeout_ms, created_at) with regex check constraint on id.
- **server/src/queries/test-utils.ts** - Added `projects` DDL to the test schema so in-memory PGlite test DBs include the table.
- **server/src/queries/projects.ts** - New query module: getAll, getById, create, update, remove, seedFromConfig (INSERT-only), hasReferencingData, isValidProjectId.
- **server/src/queries/projects.test.ts** - New test file: 14 tests covering all query functions including seeding, validation, referencing data detection.
- **server/src/routes/projects.ts** - New Fastify plugin: GET/POST /projects, GET/PATCH/DELETE /projects/:id. DELETE returns 409 if referencing data exists.
- **server/src/routes/projects.test.ts** - New test file: 13 tests covering all route handlers including error cases (409, 404, 400).
- **server/src/routes/index.ts** - Added `projectsPlugin` export.
- **server/src/index.ts** - Registered projectsPlugin, added startup seeding of projects from config.resolvedProjects.
- **server/src/config.ts** - Added `MergedProjectConfig` and `ProjectDbRow` interfaces. `getProject()` now accepts optional `dbRow` parameter to merge DB portable fields with JSON local paths. DB values override JSON for name, seed branch, and timeouts.
- **server/src/plugins/project-id.ts** - Added `projectRecord` decoration to FastifyRequest (typed as `ProjectRow | null`).
- **server/src/routes/health.ts** - Health endpoint no longer returns `projectName` by default. When `x-project-id` header is provided, looks up the project name from DB.
- **server/src/routes/health.test.ts** - Updated test assertion: `projectName` is now undefined without header.
- **scaffold.config.example.json** - Removed `planBranch` and `buildTimeoutMs`/`testTimeoutMs` from the projects block (portable fields now live in DB).
- **server/drizzle/0001_worried_marvex.sql** - Auto-generated Drizzle migration for the projects table.

## Design Decisions

1. **getProject() backward compatibility**: The `dbRow` parameter is optional, so all existing call sites continue working without changes. Future phases can pass the DB row when needed.
2. **hasReferencingData() uses Drizzle ORM**: Rather than raw SQL (which has API differences between PGlite and pg), the function imports schema tables and uses typed Drizzle queries.
3. **Health endpoint**: Chose the "accept x-project-id and return that project's name from DB" option. Without the header, no project name is returned.
4. **Project ID validation**: Regex `^[a-zA-Z0-9_-]{1,64}$` enforced both in application code (`isValidProjectId`) and as a DB-level CHECK constraint.
5. **Seed semantics**: INSERT-only. Invalid project IDs (from bad config) are silently skipped during seeding rather than throwing.

## Build & Test Results

- **Build**: SUCCESS (`npm run build` and `npm run typecheck` both clean)
- **New tests**: 28/28 pass (14 query + 13 route + 1 health)
- **Full test suite**: 425 pass, 55 fail -- all 55 failures are pre-existing (git config issues in sync tests, task dependency tests). None relate to this change.

## Open Questions / Risks

1. The `projectRecord` decoration on FastifyRequest is typed but not yet populated by the plugin's preHandler hook. Phase 1.4 says routes "should validate the project exists in the DB" but doing so in the preHandler would reject requests for projects not yet in the DB (e.g., during seeding). This is left for follow-up.
2. The `MergedProjectConfig` type extends `ProjectConfig` with a `dbRecord` sub-object. Callers that need DB fields can access them, but existing callers are unaffected.

## Suggested Follow-ups

1. Populate `request.projectRecord` in the project-id plugin by querying DB in the preHandler (requires deciding whether unknown project IDs should be rejected or allowed).
2. Add foreign key from other tables' `project_id` columns to `projects.id` once all projects are guaranteed to exist in DB.
3. Dashboard UI for managing projects (CRUD forms).
4. Consider caching the DB project lookup in the plugin to avoid per-request queries.
