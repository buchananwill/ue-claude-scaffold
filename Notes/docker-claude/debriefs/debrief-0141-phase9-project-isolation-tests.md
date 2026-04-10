# Debrief 0141 -- Phase 9 Cycle 4: Project Isolation, Test Fixes, Validation Coverage

## Task Summary

Fix all 8 review findings from cycle 3 for Phase 9. Issues spanned three files: rooms.ts (route-level project isolation, validation, cursor ordering, transcript filtering), rooms.test.ts (remove stale config args, add validation test coverage), and team-launcher.ts (remove duplicate briefPath validation).

## Changes Made

- **server/src/routes/rooms.ts**: Added `FastifyReply` import. Added `assertProjectMatch` helper function for route-level project scoping. Added project match checks after every `getRoom` call across 7 routes. Added whitespace-only name rejection. Added JSDoc to `parseMessageCursor`. Moved cursor validation before DB query in GET /rooms/:id/messages. Added `AND rooms.project_id = ?` predicate to both transcript SQL branches.
- **server/src/routes/rooms.test.ts**: Removed `{ config: createTestConfig() }` second argument from all 3 `roomsPlugin` registrations. Added 4 new test cases: invalid room id (400), name exceeding 256 chars (400), `since=abc` (400), `before=-1` (400).
- **server/src/team-launcher.ts**: Removed the duplicate inline briefPath validation block from `launchTeam()`, relying on `validateBriefOnSeedBranch` which already performs identical validation.

## Design Decisions

- `assertProjectMatch` uses `reply.code(404).send()` rather than `reply.notFound()` to return a generic `not_found` error, avoiding information leakage about cross-project rooms existing.
- Cursor validation moved before `getDb()` call to be consistent with the validate-first pattern already used in POST /rooms.

## Build & Test Results

- Build: target files compile clean (pre-existing errors in other files outside scope: tasks-claim.ts, tasks-lifecycle.ts, teams.ts).
- Tests: 36 passed, 0 failed.

## Open Questions / Risks

- Pre-existing build errors in tasks-claim.ts, tasks-lifecycle.ts, tasks-types.ts, and teams.ts are not in scope.
- The `queries/rooms.ts` `getRoom` function still lacks a native projectId filter; route-level checks are a viable workaround but a query-level filter would be more defense-in-depth.

## Suggested Follow-ups

- Add projectId parameter to `roomsQ.getRoom()` in queries/rooms.ts for defense in depth.
- Fix pre-existing build errors in tasks and teams routes.
