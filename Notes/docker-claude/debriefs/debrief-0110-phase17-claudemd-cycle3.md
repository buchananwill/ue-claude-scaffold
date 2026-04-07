# Debrief 0110 — Phase 17 Cycle 3: CLAUDE.md endpoint accuracy

## Task Summary
Fix documentation inaccuracies in CLAUDE.md endpoint listing, based on review findings from Phase 17 Cycle 3.

## Changes Made
- **CLAUDE.md**: Removed non-existent `GET /messages` from endpoint list (B1). The actual GET endpoints are `GET /messages/{channel}` and `GET /messages/{channel}/count`. Also added `DELETE /messages/{param}` which was missing.
- **CLAUDE.md**: Added `GET /config` endpoint to list all project IDs (W1). Was already listing `GET /config/{projectId}` but missing the root `GET /config`.
- **CLAUDE.md**: Added `POST /projects/{id}/seed/bootstrap` endpoint for bare repo bootstrapping (W2).
- **CLAUDE.md**: Expanded projects endpoint listing from `GET /projects, POST /projects` to include `GET /projects/{id}`, `PATCH /projects/{id}`, `DELETE /projects/{id}` (W3).

## Design Decisions
- Cross-checked every endpoint against actual route files in `server/src/routes/` before documenting.
- Kept endpoint descriptions concise and consistent with existing style.

## Build & Test Results
Documentation-only change (CLAUDE.md). No build or test impact.

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
