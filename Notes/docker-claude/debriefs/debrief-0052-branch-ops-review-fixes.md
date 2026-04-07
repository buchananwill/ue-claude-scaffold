# Debrief 0052 -- Branch Ops Review Findings (Cycle 1)

## Task Summary
Fix all review findings from three reviewers on the branch-ops implementation (Phase 3, Cycle 1). Eleven issues total: 5 blocking, 6 warnings.

## Changes Made
- **server/src/branch-ops.ts**: Added optional `seedBranch` to `EnsureAgentBranchOpts` and `BootstrapBareRepoOpts`. Updated `seedBranchSha` to accept optional `projectConfig` and pass it to `seedBranchFor`. Fixed `ensureAgentBranch` fresh=true path to check branch existence and return `created` vs `reset` accordingly. Added `encoding: 'utf-8'` to git clone in `bootstrapBareRepo`.
- **server/src/routes/branch-ops.ts**: Changed bootstrap route URL from `/projects/:id/seed:bootstrap` to `/projects/:id/seed/bootstrap`. Added `MergedProjectConfig` import and type annotations on `let project`. Removed `projectPath` from body schema; now uses `project.path` from resolved config. Added `additionalProperties: false` to all schema objects. Changed error handlers to log server-side and return generic messages. Added trust boundary comment on bootstrap route. Pass `project.seedBranch` to both `ensureAgentBranch` and `bootstrapBareRepo`.
- **server/src/branch-ops.test.ts**: Imported `seedBranchFor` and used it in `createSeedBranch` helper instead of hard-coded branch name. Added test for `ensureAgentBranch` with `fresh=true` when branch does not exist (asserts `action === 'created'`).

## Design Decisions
- For Fix 3 (unvalidated projectPath), rather than adding path validation, the body parameter was removed entirely and `project.path` from the resolved config is used. This is the safest approach since the config is trusted.
- For Fix 5 (seedBranch override), the `seedBranch` is passed as a flat optional field in opts rather than nesting a projectConfig object, keeping the interface simpler.

## Build & Test Results
- Build: SUCCESS (`npm run build`)
- Tests: 12 passed, 0 failed (`npx tsx --test src/branch-ops.test.ts`)

## Open Questions / Risks
None.

## Suggested Follow-ups
- Route-level integration tests for the Fastify handlers (currently only unit tests on the pure functions).
