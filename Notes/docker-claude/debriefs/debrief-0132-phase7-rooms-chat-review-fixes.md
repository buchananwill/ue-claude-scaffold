# Debrief 0132 -- Phase 7 Review Findings: rooms.ts and chat.ts

## Task Summary
Fix five review findings in `server/src/queries/rooms.ts` and `server/src/queries/chat.ts`: canonical DbOrTx import, missing return types, consistent select projection, moving module-level SQL expressions into function scope, and adding an 'unknown' fallback to COALESCE.

## Changes Made
- **server/src/queries/rooms.ts**: Replaced local `DbOrTx` type alias with canonical import from `drizzle-instance.js`. Added explicit return types to `createRoom` and `getRoom`. Changed bare `db.select()` in `listRooms` non-member branch to use explicit column projection matching the member-filtered branch.
- **server/src/queries/chat.ts**: Replaced local `DbOrTx` type alias with canonical import from `drizzle-instance.js`. Added explicit return type to `sendMessage`. Moved `senderColumn` and `historySelect` inside `getHistory` function body. Added `'unknown'` fallback to the COALESCE expression. Added explicit return type to `getHistory`.

## Design Decisions
- Used `sender: unknown` in the `getHistory` return type since Drizzle's `sql` template returns `SQL<unknown>` and the actual runtime value is a string but the type system cannot infer it from raw SQL.
- Return types for `createRoom` and `getRoom` mirror the rooms table schema shape exactly.

## Build & Test Results
- Build succeeds with no errors in `rooms.ts` or `chat.ts`. Errors exist in caller files (route files, test files) which are out of scope per task instructions.

## Open Questions / Risks
- Caller files (`routes/rooms.ts`, `team-launcher.ts`) reference `SendMessageOpts.sender` and `chat.isMember` which do not exist -- these are pre-existing issues in other files, not caused by this change.

## Suggested Follow-ups
- Fix caller errors in route files that reference removed/renamed APIs.
