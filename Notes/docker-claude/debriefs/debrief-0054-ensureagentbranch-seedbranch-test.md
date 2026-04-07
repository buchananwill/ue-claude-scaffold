# Debrief 0054: ensureAgentBranch seedBranch Override Test

## Task Summary

Add a missing test for the `seedBranch` override parameter in `ensureAgentBranch`. The test must create a custom branch, avoid creating the default seed branch, call `ensureAgentBranch` with `seedBranch` override, and assert `action === 'created'` with the correct SHA.

## Changes Made

- **server/src/branch-ops.test.ts** (modified): Added test "creates agent branch from a custom seedBranch override (fresh=false)" to the `ensureAgentBranch` describe block. The test creates a `custom/agent-seed` branch, uses a projectId (`noseed`) that has no default seed branch, and verifies that `ensureAgentBranch` with `seedBranch: 'custom/agent-seed'` returns `action: 'created'` with the correct SHA.

## Design Decisions

- Used a projectId (`noseed`) that has no default seed branch created, proving the override is actually used rather than falling back to defaults.
- Verified the agent branch SHA in git directly to confirm the ref was created correctly.

## Build & Test Results

- Build: SUCCESS (`npm run build`)
- Tests: 15 passed, 0 failed (`npx tsx --test src/branch-ops.test.ts`)

## Open Questions / Risks

None.

## Suggested Follow-ups

None.
