# Debrief 0048 -- Phase 2 Review Fixes Cycle 1

## Task Summary

Fix all review findings from three reviewers on the config-resolver and config route implementation. Includes blocking issues (test structure, input validation, malformed JSON test, hard-coded timeout defaults) and warnings (naming conventions, error handling, comments).

## Changes Made

- **server/src/config-resolver.ts** -- Changed timeout fallbacks from `config.build.*` references to hard-coded constants (660_000 / 700_000). Added comment explaining why `defaultTestFilters` uses global config only.
- **server/src/routes/config.ts** -- Renamed `fastify` parameter to `app`, destructured `config` from options. Added JSON Schema validation on `:projectId` param with pattern `^[a-zA-Z0-9_-]{1,64}$`. Changed error handler to log with `request.log.warn`, return generic "Project not found" for unknown-project errors, and re-throw other errors for Fastify's 500 handler.
- **server/src/routes/config.test.ts** (NEW) -- Moved route tests from `config-resolver.test.ts` into this file per convention. Uses `beforeEach`/`afterEach` pattern with `ctx.app.close()` and `ctx.cleanup()`. Replaced `JSON.parse(res.payload)` with `res.json()`. Added test for invalid projectId format returning 400.
- **server/src/config-resolver.test.ts** -- Removed route test block and unused imports (`ResolvedProjectConfig`, `ScaffoldConfig`, `createDrizzleTestApp`, `configPlugin`).
- **server/src/config.test.ts** -- Added malformed JSON test for `loadConfig()` that writes invalid JSON to a temp file and asserts the "not valid JSON" error message.

## Design Decisions

- For CORRECTNESS W2, the catch block now checks if the error message matches "Unknown project" before returning 404. All other errors are re-thrown so Fastify returns 500, preventing masking of unexpected failures.
- The malformed JSON test was added to `config.test.ts` (not `config-resolver.test.ts`) since `resolveProjectConfig` takes a pre-parsed config and the JSON parsing is in `loadConfig()`.

## Build & Test Results

- Build: SUCCESS (`npm run build`)
- `config-resolver.test.ts`: 6 passed, 0 failed
- `routes/config.test.ts`: 5 passed, 0 failed
- `config.test.ts`: 17 passed, 0 failed

## Open Questions / Risks

None identified.

## Suggested Follow-ups

None.
