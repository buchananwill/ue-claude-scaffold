# Debrief 0038 - Phase 4 Review Cycle 1 Fixes

## Task Summary

Fix 2 BLOCKING and 8 WARNING issues found by reviewers in Phase 4 (URL-driven state) dashboard changes.

## Changes Made

- **dashboard/src/router.tsx** -- Added `boundedString` helper for length-capped string param validation. Added allowlists for build type (`build`|`test`), result (`pass`|`fail`), and message type (6 known types). Applied length caps to all `agent` params across all routes. Updated MessagesPage imports to use split components (MessagesIndexPage, MessagesChannelPage). [W4, W5, B2]
- **dashboard/src/pages/BuildLogPage.tsx** -- Renamed `successFilter` to `resultFilter` for naming consistency with URL param. Removed redundant `<Collapse>` wrapper that never animated (parent was conditionally mounted). Replaced `style={{ width: 180 }}` with Mantine `w={180}` prop. Added comment explaining why result filtering is client-side (server lacks `success` query param). Replaced fallthrough `return true` with exhaustiveness assertion. [B1, W1, W2, W3, W6]
- **dashboard/src/pages/MessagesPage.tsx** -- Split single `MessagesPage` (which used `strict: false` with type cast) into `MessagesIndexPage` and `MessagesChannelPage` wrappers, each calling `useSearch`/`useParams` with proper `from` route path. Both delegate to a shared `MessagesContent` component. [B2]
- **dashboard/src/pages/OverviewPage.tsx** -- Replaced inline `statusFilter` Set construction with a simpler `statusParam` useMemo that only extracts the single-status server param. Removed the duplicate `Set<string>` parsing that was also done inside `useTaskFiltersUrlBacked`. Added comment documenting the intentional duplication of status string parsing (needed because useTasks must be called before useTaskFiltersUrlBacked). [W7]
- **dashboard/src/hooks/useTaskFilters.ts** -- Removed `any` type annotation on `prev` parameter in `setPage` navigate callback, letting TanStack Router infer the correct type. [W8]

## Design Decisions

- For B1, kept client-side filtering since the server's GET /builds endpoint does not accept a `success` query parameter and returns all records without pagination. Documented this with a clear comment.
- For B2, chose the two-wrapper approach since the two routes have slightly different search schemas (channel route has `highlight`).
- For W4, used a shared `VALID_MESSAGE_TYPES` set for both message routes. Applied the same `boundedString` helper consistently.
- For W8, simply removed the `: any` annotation instead of trying to construct a complex explicit type. TanStack Router correctly infers `prev` from the `from` route option already set on `useNavigate`.

## Build & Test Results

- Build: SUCCESS (`npm run build` in dashboard/)
- No test suite for dashboard (SPA with no unit tests configured).

## Open Questions / Risks

- The exhaustiveness assertion on `resultFilter` uses `as never` cast. If someone adds a new result value to the router allowlist but forgets to update the filter logic, this will produce a TypeScript error at build time, which is the desired behavior.

## Suggested Follow-ups

- Consider adding a `success` query param to the server's GET /builds endpoint to enable server-side result filtering if pagination is ever added.
- Consider adding unit tests for the dashboard validation logic.
