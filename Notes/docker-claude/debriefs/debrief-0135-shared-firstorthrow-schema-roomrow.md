# Debrief 0135 — Shared firstOrThrow helper, schema-derived RoomRow

## Task Summary
Extract the duplicated `firstOrThrow` helper from rooms.ts and chat.ts into a shared module, and replace the hand-written RoomRow type with a Drizzle schema-derived type.

## Changes Made
- **server/src/queries/query-helpers.ts** — Created. Exports `firstOrThrow<T>` generic helper.
- **server/src/queries/rooms.ts** — Modified. Removed local `firstOrThrow` and TODO comment, imported from query-helpers.js. Replaced 6-field manual `RoomRow` type with `InferSelectModel<typeof rooms>`.
- **server/src/queries/chat.ts** — Modified. Removed local `firstOrThrow` and TODO comment, imported from query-helpers.js.

## Design Decisions
- `InferSelectModel<typeof rooms>` produces the identical shape to the hand-written type (id, projectId, name, type, createdBy, createdAt) since the rooms table schema matches exactly.

## Build & Test Results
- Build: the three target files compile without errors. Pre-existing errors exist in other files (routes, test files) that are outside scope.
- Tests: rooms.test.ts has 5 pass / 4 fail, chat.test.ts has 6 cancelled. All failures are pre-existing (confirmed identical results before and after changes via git stash).

## Open Questions / Risks
- None for these changes.

## Suggested Follow-ups
- Fix pre-existing test failures in rooms.test.ts and chat.test.ts (argument type mismatches, missing `isMember` export, `sender` property issues).
