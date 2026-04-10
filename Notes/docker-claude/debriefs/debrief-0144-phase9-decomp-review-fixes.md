# Debrief 0144 - Phase 9 Decomp Review Fixes

## Task Summary
Fix 4 WARNING-level review findings from the post-decomposition review:
1. Unify `requireRoom` response shape and include room ID in message
2. Replace remaining raw SQL with Drizzle operators in tasks-lifecycle.ts and coalesce.ts
3. Fix test isolation in rooms.test.ts (seed agent rows before addMember)
4. Change getMembers ordering from agents.name to roomMembers.joinedAt

## Changes Made
- **server/src/routes/rooms.ts**: Collapsed two conditions in `requireRoom` into one, unified to `reply.notFound(...)` with room ID in message
- **server/src/queries/query-helpers.ts**: Added `TERMINAL_STATUSES` and `INACTIVE_AGENT_STATUSES` constants
- **server/src/queries/tasks-lifecycle.ts**: Replaced `sql\`...IN ('completed','failed','cycle')\`` with `inArray(tasks.status, [...TERMINAL_STATUSES])`
- **server/src/queries/coalesce.ts**: Replaced `sql\`...NOT IN ('stopping','done','error','paused')\`` with `notInArray(agents.status, [...INACTIVE_AGENT_STATUSES])`, removed unused `sql` import
- **server/src/queries/rooms.test.ts**: Seeded agent rows with proper UUID IDs and worktree fields in `before()`, removed duplicate agent insert from presence test, updated all addMember calls to use UUID constants
- **server/src/queries/rooms.ts**: Changed `getMembers` ordering from `agents.name` to `roomMembers.joinedAt`

## Design Decisions
- Used `uuidv7()` at module scope to create deterministic test agent IDs, matching the pattern used in other query tests
- Only changed ordering for `getMembers`, not `getPresence`, as the task only specified `getMembers`
- Kept `getPresence` ordering by `agents.name` since it was not flagged

## Build & Test Results
- Typecheck: No errors in changed files (pre-existing errors in unrelated files remain)
- `npx tsx --test src/queries/rooms.test.ts`: 9/9 pass
- `npx tsx --test src/routes/rooms.test.ts`: 30/30 pass

## Open Questions / Risks
- Pre-existing TS errors in coalesce.test.ts and tasks-lifecycle.test.ts (missing `id` field and wrong argument counts) are outside scope

## Suggested Follow-ups
- Fix argument count mismatches in route callers for tasks-lifecycle query functions
- Fix pre-existing test compilation errors in coalesce.test.ts and tasks-lifecycle.test.ts
