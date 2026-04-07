# Debrief 0051 -- Phase 3: Server-side Branch Operations

## Task Summary

Implement server-side branch management operations (Steps 15-18 of the shell script refactor plan). This moves branch creation, reset, resume, migration, and bootstrap logic from shell scripts into TypeScript with unit tests and REST endpoints.

## Changes Made

- **server/src/branch-ops.ts** (created): Core branch operations module with four exported functions:
  - `seedBranchSha()` -- resolve SHA of a project's seed branch
  - `ensureAgentBranch()` -- create, reset, or resume an agent branch
  - `migrateLegacySeedBranch()` -- migrate `docker/current-root` to `docker/{projectId}/current-root`
  - `bootstrapBareRepo()` -- clone a project as a bare repo and create the seed branch

- **server/src/branch-ops.test.ts** (created): 11 unit tests covering all functions and edge cases (create, resume, reset, migration, missing seed branch, already-exists errors)

- **server/src/routes/branch-ops.ts** (created): Fastify route plugin with two endpoints:
  - `POST /agents/:name/branch` -- ensure agent branch (create/reset/resume)
  - `POST /projects/:id/seed:bootstrap` -- bootstrap bare repo from project path

- **server/src/routes/index.ts** (modified): Added `branchOpsPlugin` export
- **server/src/index.ts** (modified): Registered `branchOpsPlugin` with config

## Design Decisions

- Used `execFileSync` with argument arrays exclusively (no `exec`, no template strings) to prevent shell injection.
- Used `spawnSync` for branch existence checks where a non-zero exit code is expected (avoids try/catch noise).
- Route file is separate from agents.ts to keep concerns clean, as recommended in the plan.
- `bootstrapBareRepo` guards against overwriting an existing bare repo by checking `existsSync` first.
- Tests use real temporary git repos (mkdtempSync + git init) rather than mocks, giving high confidence in correctness.

## Build & Test Results

- **Build**: SUCCESS (`npm run build`)
- **Tests**: 11 passed, 0 failed (`npx tsx --test src/branch-ops.test.ts`)
- Full test suite shows 58 pre-existing failures unrelated to branch-ops changes.

## Open Questions / Risks

- The route tests for `POST /agents/:name/branch` and `POST /projects/:id/seed:bootstrap` are not included because they would require both a DB test context and a real git repo, making them integration-level tests. The core logic is thoroughly tested via the unit tests in `branch-ops.test.ts`.
- Steps 19-22 (shell script modifications to call these endpoints) are deferred per the plan.

## Suggested Follow-ups

- Add integration tests for the two REST endpoints once a test pattern for combined DB + git fixtures is established.
- Wire `launch.sh` and `setup.sh` to call the new endpoints instead of inline git operations (Steps 19-22).
