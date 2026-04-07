# Debrief 0056 — Hook Review Findings Cycle 1

## Task Summary
Address review findings from the hook resolution feature: remove unused `projectId` from the interface, replace manual validation with JSON Schema, add HTTP route tests, and add auth comment.

## Changes Made
- **server/src/hook-resolution.ts** — Removed `projectId` field from `HookResolutionInput` interface (unused by `resolveHooks()`).
- **server/src/hook-resolution.test.ts** — Removed all `projectId: 'proj'` from test inputs to match updated interface.
- **server/src/routes/hooks.ts** — Replaced manual `typeof` validation with Fastify JSON Schema on the route. Added a scoped Ajv instance with `coerceTypes: false` so string values like `"true"` are rejected rather than silently coerced. Removed `isValidProjectId` import and all manual checks. Added auth comment at top.
- **server/src/routes/hooks.test.ts** — Created with 6 tests: valid body, missing hasBuildScript, hasBuildScript as string, nested boolean as string, empty body, full cascade.

## Design Decisions
- Used a scoped `setValidatorCompiler` with `coerceTypes: false` within the hooks plugin rather than changing the global Fastify AJV config. This avoids affecting other routes that may rely on type coercion.
- Used Ajv v8 style `type: ['boolean', 'null']` instead of deprecated `nullable: true` keyword.
- The route test uses a standalone Fastify instance (no DB needed) since the endpoint is stateless computation.

## Build & Test Results
- Build: SUCCESS (`npm run build`)
- hook-resolution.test.ts: 13 passed, 0 failed
- routes/hooks.test.ts: 6 passed, 0 failed

## Open Questions / Risks
- The `as any` cast on the Ajv constructor is needed due to ESM/CJS interop. This is a minor type-safety gap but functionally correct.

## Suggested Follow-ups
- None.
