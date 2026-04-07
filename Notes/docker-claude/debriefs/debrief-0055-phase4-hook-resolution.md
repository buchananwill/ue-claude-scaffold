# Debrief 0055 -- Phase 4: Server-side Hook Resolution

## Task Summary
Implement server-side hook flag resolution (Steps 23-25 of the shell script refactor plan). This moves the 5-level hook cascade (system default, project, team, member, CLI) from shell scripts into a TypeScript module with a corresponding HTTP endpoint.

## Changes Made
- **server/src/hook-resolution.ts** -- Created. Exports `resolveHooks()` function and supporting types (`HookResolutionInput`, `ResolvedHooks`, `HookFlags`). Implements `cascadeFlag()` helper that applies overrides in order, skipping null/undefined values.
- **server/src/hook-resolution.test.ts** -- Created. 13 tests covering: system defaults with/without build script, project/team/member/CLI overrides, partial overrides, null/undefined pass-through, full cascade with all levels set.
- **server/src/routes/hooks.ts** -- Created. Fastify plugin with `POST /hooks/resolve` endpoint. Validates projectId format and hasBuildScript presence, delegates to `resolveHooks()`.
- **server/src/routes/index.ts** -- Modified. Added `hooksPlugin` export.
- **server/src/index.ts** -- Modified. Imported and registered `hooksPlugin`.

## Design Decisions
- The `cascadeFlag` function uses `!= null` (covers both null and undefined) to match the shell script's `[ -n "$2" ]` semantics where empty means "no override".
- The route does not require DB access -- it is pure computation. No config dependency needed.
- Input validation uses `isValidProjectId` from branch-naming for consistency with other routes.

## Build & Test Results
- Build: SUCCESS (`npm run build`)
- Hook resolution tests: 13/13 PASS
- Full suite: 434 pass, 58 fail (all failures pre-existing in sync and task-dependency tests, unrelated to this change)

## Open Questions / Risks
- Steps 26-27 (shell script changes to call this endpoint) are deferred per the plan.

## Suggested Follow-ups
- Integration test for `POST /hooks/resolve` via HTTP (currently only unit-tested the pure function).
- Shell script changes (Steps 26-27) to replace the inline cascade with a curl call to this endpoint.
