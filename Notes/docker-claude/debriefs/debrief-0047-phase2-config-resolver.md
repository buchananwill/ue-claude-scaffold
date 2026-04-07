# Debrief 0047 -- Phase 2: Server-side Config Resolver

## Task Summary

Create a REST-accessible config resolver so shell scripts can eventually fetch resolved project configuration via a single `GET /config/:projectId` curl call instead of parsing `scaffold.config.json` with jq. This phase covers the server-side work only (steps 7-10, 13 from the plan).

## Changes Made

- **server/src/config-resolver.ts** (created) -- New module exporting `ResolvedProjectConfig` interface and `resolveProjectConfig()` function. Wraps existing `getProject()` from config.ts, flattening the nested config into a shell-script-friendly shape with sensible defaults.
- **server/src/config-resolver.test.ts** (created) -- 10 tests covering: legacy config resolution, multi-project resolution, unknown project ID throws, missing engine (optional), custom server port, custom test filters, and 4 route-level tests (GET /config index, multiple project IDs, GET /config/:projectId success, 404 for unknown).
- **server/src/routes/config.ts** (created) -- Fastify plugin with `GET /config` (returns `{ projectIds }`) and `GET /config/:projectId` (returns resolved config JSON or 404).
- **server/src/routes/index.ts** (modified) -- Added `configPlugin` barrel export.
- **server/src/index.ts** (modified) -- Imported and registered `configPlugin` with `{ config }`.

## Design Decisions

- The `ResolvedProjectConfig` interface includes placeholder `null` fields for `logsPath`, `agentType`, and `hooks` since the current config schema does not yet carry these. This keeps the contract stable for shell scripts to consume without breaking when those fields are added later.
- `buildTimeoutMs` / `testTimeoutMs` fall back to `config.build.*` top-level defaults when the project-level config does not specify them.
- `seedBranch` uses `seedBranchFor()` from branch-naming.ts to compute the default `docker/{projectId}/current-root` pattern when no explicit seed branch is configured.
- Shell script modifications were explicitly excluded from this phase per the plan's final revision.

## Build & Test Results

- **Typecheck**: PASS (`npm run typecheck`)
- **Build**: PASS (`npm run build`)
- **Tests**: 10 passed, 0 failed (`npx tsx --test src/config-resolver.test.ts`)

## Open Questions / Risks

- The `logsPath`, `agentType`, and `hooks` fields are always null. When the config schema adds support for these, the resolver will need updating.
- Route tests each spin up a PGlite instance (~2s each). This is the standard pattern in this codebase but makes the test suite slow.

## Suggested Follow-ups

- Phase 2 steps 11-14: Migrate shell scripts to use `GET /config/:projectId` with fallback to local jq parsing.
- Add `logsPath`, `agentType`, and hook paths to `ProjectConfig` / `scaffold.config.json` schema.
