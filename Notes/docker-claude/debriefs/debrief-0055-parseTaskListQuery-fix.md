# Debrief 0055 -- parseTaskListQuery regression fix

## Task Summary

Fix a critical regression where `parseTaskListQuery` called `reply.badRequest()` without returning the value to Fastify, causing all GET /tasks input validation to silently return 200 instead of 400. Also apply two dashboard style fixes.

## Changes Made

- **server/src/routes/tasks.ts** -- Refactored `parseTaskListQuery` to return a discriminated union `ParseResult` (`{ ok: true, data }` | `{ ok: false, error }`) instead of accepting `reply` and calling `reply.badRequest()` internally. Removed `async` keyword (no awaits). Updated the GET /tasks handler to use the new return type and call `reply.badRequest(parsed.error)` in the handler itself, ensuring Fastify receives the reply. Removed unused `FastifyReply` import.
- **dashboard/src/constants/task-statuses.ts** -- Removed unnecessary `as ReadonlyArray<string>` cast from `TASK_STATUSES`. `Object.keys()` already returns `string[]` which is sufficient for all consumers.
- **dashboard/src/hooks/useTaskFilters.ts** -- Removed re-export of `TASK_STATUSES` and `STATUS_LABELS`. No consumers import these from `useTaskFilters`; all use `constants/task-statuses.js` directly.

## Design Decisions

- Used a discriminated union return type rather than throwing, to keep the function pure and testable. The caller (route handler) is the only place that should interact with `reply`.

## Build & Test Results

- Server build: SUCCESS
- Dashboard build: SUCCESS
- Tasks tests: 45/45 pass in the main `tasks routes` suite. All validation tests (invalid sort, invalid dir, invalid status, invalid priority, empty segments, max values) correctly return 400. Failures in other nested describe blocks are pre-existing (git identity not configured in container environment).

## Open Questions / Risks

None. The fix is straightforward and all affected tests pass.

## Suggested Follow-ups

None.
