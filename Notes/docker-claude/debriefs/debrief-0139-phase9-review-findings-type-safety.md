# Debrief 0139: Phase 9 Review Findings -- Type Safety, Operator Label, briefPath Validation

## Task Summary
Fix all review findings from Phase 9 of schema hardening V2.5 in `rooms.ts` and `team-launcher.ts`. Issues ranged from missing PluginOpts pattern, `any` type annotations, name-to-UUID resolution in POST /rooms, operator label corrections, transcript CASE expression fixes, and briefPath validation.

## Changes Made

- **server/src/routes/rooms.ts**: Added `ScaffoldConfig` import, `RoomsOpts` interface, and `FastifyPluginAsync<RoomsOpts>` generic. Changed caller default from `'user'` to `'operator'`. Resolved agent UUIDs via `agentsQ.getByName` before calling `addMember` in POST /rooms (creator and members). Operators skip member auto-add (implicit access). Used `Promise.all` for parallel member inserts. Removed `: any` from two `.map()` callbacks. Removed dead `r.created_by` fallback. Fixed transcript CASE: `'operator' THEN 'operator'` and added `ELSE 'unknown'`.
- **server/src/team-launcher.ts**: Changed `createdBy: 'user'` to `createdBy: 'operator'`. Added briefPath validation regex before `validateBriefOnSeedBranch` call.
- **server/src/index.ts**: Updated `roomsPlugin` registration to pass `{ config }`.
- **server/src/routes/rooms.test.ts**: Added `seedAgent` helper to insert agent rows directly. Seeded agents in beforeEach blocks. Updated broadcast tests to use operator flow. Fixed direct-room member test to join with agents table. Removed obsolete 'user' membership tests, replaced with operator implicit access test.

## Design Decisions
- For the B-ALL-CRITICAL fix: operators (no X-Agent-Name header) are not added as room members when creating rooms. This aligns with the operator implicit access pattern used in GET /rooms/:id/messages.
- The `Promise.all` for members uses `throw fastify.httpErrors.notFound()` which will reject the promise and surface to the client as a 404.
- briefPath validation uses a whitelist regex plus explicit `..` and null-byte rejection, applied at the start of `launchTeam` before any git operations.

## Build & Test Results
- Build: Pre-existing errors in unrelated test files (agents.test.ts, chat.test.ts, tasks-lifecycle.test.ts, teams.test.ts). No errors in files I modified.
- Tests: 32 passed, 0 failed in rooms.test.ts.

## Open Questions / Risks
- teams.test.ts registers roomsPlugin without config -- will break once TypeScript enforces the generic. Explicitly Phase 10 scope per instructions.
- The broadcast test "member is unregistered (pending)" now registers ghost-agent first, which changes the test semantics slightly. The original intent was to test unregistered members, but with UUID FK requirements this is no longer possible without DB-level insertion.

## Suggested Follow-ups
- Phase 10: Update teams.test.ts to pass config to roomsPlugin.
- Consider adding body schema validation (Ajv) for POST /rooms to reject missing/invalid fields before handler logic.
