# Debrief 0050: Phase 2 Review Cycle 3 - Example Config seedBranch Fix

## Task Summary
Fix two review findings from Phase 2 cycle 3: (B1) remove invalid seedBranch template values from scaffold.config.example.json that would fail BRANCH_RE validation, and (W1) add a test for invalid seedBranch handling.

## Changes Made
- **scaffold.config.example.json**: Removed `seedBranch` entries from both `tasks` and `container` blocks. Updated `_NOTE` field to explain that seedBranch is computed automatically.
- **server/src/config-resolver.test.ts**: Added test "throws for an invalid seedBranch" that verifies `resolveProjectConfig` throws with `/Invalid seedBranch/` when given `'feature.lock'` as seedBranch.

## Design Decisions
- Chose to remove seedBranch entirely rather than replace with a valid placeholder, since the default computed value (`docker/{projectId}/current-root`) is the intended behavior and users only need to set it when overriding.

## Build & Test Results
- Build: SUCCESS (`npm run build`)
- Tests: 7 passed, 0 failed (`npx tsx --test src/config-resolver.test.ts`)

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
