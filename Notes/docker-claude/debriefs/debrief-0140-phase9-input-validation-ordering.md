# Debrief 0140 -- Phase 9 Input Validation and Ordering Fixes

## Task Summary

Fix review findings from cycle 2 for Phase 9 covering input validation, cursor sanitization, unused config removal, room filter format checks, briefPath validation placement, and room creation ordering in `rooms.ts`, `team-launcher.ts`, and `index.ts`.

## Changes Made

- **server/src/routes/rooms.ts**: Added `ROOM_ID_RE` regex and `parseMessageCursor()` helper. Added id/name validation in POST /rooms (B-SAFETY-1). Validated since/before query params with safe integer check (B-SAFETY-2). Removed unused `config` parameter, `RoomsOpts` interface, `ScaffoldConfig` import (W-STYLE-1). Added roomFilter format check in transcript route (W-SAFETY-1). Reordered POST /rooms to resolve agent and member UUIDs before creating room (W-SAFETY-3).
- **server/src/team-launcher.ts**: Duplicated briefPath validation into `validateBriefOnSeedBranch()` so the exported function is self-protecting (W-SAFETY-2). Kept existing validation in `launchTeam()` as defense-in-depth.
- **server/src/index.ts**: Removed `{ config }` option from `roomsPlugin` registration (W-STYLE-1).

## Design Decisions

- `parseMessageCursor` returns `NaN` as a sentinel for invalid values rather than throwing, so the caller can return a 400 via `reply.badRequest()` instead of requiring try/catch.
- For W-SAFETY-3, changed from `Promise.all` to sequential `for` loop for member resolution to ensure deterministic error behavior (first unknown member triggers 404).
- Kept briefPath validation in both `validateBriefOnSeedBranch` and `launchTeam` per the task instruction "keep or duplicate."

## Build & Test Results

Build: All 160 pre-existing TypeScript errors are in other files (test files, queries, other routes). Zero errors in `rooms.ts`, `team-launcher.ts`, or `index.ts`.

## Open Questions / Risks

- The 160 pre-existing errors in test/query files are from prior phases and unrelated to this work.

## Suggested Follow-ups

- Fix the pre-existing test compilation errors across query and route test files.
