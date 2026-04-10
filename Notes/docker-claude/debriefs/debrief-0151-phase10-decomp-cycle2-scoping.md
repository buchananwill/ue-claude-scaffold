# Debrief 0151 - Phase 10 Decomp Cycle 2: Scope Mutations by projectId

## Task Summary
Fix BLOCKING and WARNING findings from post-decomp review cycle 2:
- B1: Add projectId scoping to dissolve, updateStatus, deleteTeam in teams.ts and deleteRoom in rooms.ts
- B2: Remove body.projectId override in POST /teams/:id/launch
- W1: Add ACTIVE_STATUSES guard to updateProgress in tasks-lifecycle.ts

## Changes Made
- **server/src/queries/teams.ts**: Added `projectId: string` parameter to `dissolve`, `updateStatus`, and `deleteTeam`; added `eq(teams.projectId, projectId)` to WHERE clauses using `and()`.
- **server/src/queries/rooms.ts**: Added optional `projectId?: string` parameter to `deleteRoom`; scopes by projectId when provided.
- **server/src/routes/teams.ts**: Updated all callers of dissolve/updateStatus/deleteTeam/deleteRoom to pass `request.projectId`. Removed `projectId` from POST /teams/:id/launch body interface; always use `request.projectId`.
- **server/src/team-launcher.ts**: Updated deleteRoom and deleteTeam calls to pass `projectId`.
- **server/src/team-launcher.test.ts**: Updated dissolve call to pass projectId argument.
- **server/src/routes/rooms.ts**: Updated deleteRoom call to pass `request.projectId`.
- **server/src/queries/tasks-lifecycle.ts**: Added `inArray(tasks.status, [...ACTIVE_STATUSES])` to updateProgress WHERE clause.

## Design Decisions
- Made `deleteRoom`'s projectId optional to avoid breaking callers that don't have project context (test files). The teams.ts query functions use required projectId since they are always called with project context.

## Build & Test Results
- Typecheck passes for all non-test files. Pre-existing test file errors remain (out of scope).

## Open Questions / Risks
- None.

## Suggested Follow-ups
- Update test files to match new function signatures (pre-existing errors from prior phases).
