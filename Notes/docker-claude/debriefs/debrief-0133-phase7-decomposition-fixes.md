# Debrief 0133 -- Phase 7 Decomposition Fixes (rooms.ts, chat.ts)

## Task Summary
Fix 3 DRY violations found in decomposition review of rooms.ts and chat.ts query modules.

## Changes Made
- **server/src/queries/rooms.ts**: Extracted `RoomRow` type alias used as return type for `createRoom`, `getRoom`, `listRooms`. Hoisted `roomSelect` constant inside `listRooms` to eliminate duplicated 6-column select object. Added `firstOrThrow` helper replacing inline insert guard.
- **server/src/queries/chat.ts**: Added `firstOrThrow` helper replacing inline insert guard in `sendMessage`.

## Design Decisions
- `firstOrThrow` is duplicated in both files with a `// TODO: extract to shared query helpers` comment, per instructions. A shared module would be better but was out of scope.
- `roomSelect` is scoped inside `listRooms` rather than at module level since it is only used there; keeps it close to usage.
- `RoomRow` is exported so consumers can reference it if needed.

## Build & Test Results
Pending initial build.

## Open Questions / Risks
None -- these are mechanical DRY extractions with no behavior change.

## Suggested Follow-ups
- Extract `firstOrThrow` into a shared query-helpers module used by all query files.
