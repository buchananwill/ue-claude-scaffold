# Debrief 0041 - Decomposition Review DRY Fixes

## Task Summary
Fix 7 DRY violations identified by the decomposition reviewer across the dashboard codebase.

## Changes Made

- **dashboard/src/utils/toErrorMessage.ts** (created): Shared `toErrorMessage(err: unknown): string` utility.
- **dashboard/src/hooks/useCursorPolling.ts** (created): Generic cursor-based polling hook parameterised by URL builder, with callbacks for initial load, poll append, and older-item transforms. [W1]
- **dashboard/src/hooks/useMessages.ts** (modified): Rewritten as thin wrapper around `useCursorPolling`, retaining `totalCount` fetch via `onInitialLoad` callback. [W1]
- **dashboard/src/hooks/useChatMessages.ts** (modified): Rewritten as thin wrapper around `useCursorPolling`, retaining unread count and reverse-sort for older messages. [W1]
- **dashboard/src/api/client.ts** (modified): Extracted private `apiMutate` helper; `apiPost`, `apiPatch`, `apiDelete` are now one-line wrappers. [W2]
- **dashboard/src/hooks/useTaskFilters.ts** (modified): Exported `VALID_SORT_COLUMNS`. [W3]
- **dashboard/src/router.tsx** (modified): Imported `TASK_STATUSES` and `VALID_SORT_COLUMNS` from `useTaskFilters.ts` instead of defining duplicates. [W3, W4]
- **dashboard/src/components/AgentMessageCard.tsx** (created): Shared card component with colored left border, agent name, timestamp, and children slot. [W5]
- **dashboard/src/components/ChatTimeline.tsx** (modified): Uses `AgentMessageCard` and `toErrorMessage`. Removed unused `Paper` import. [W5, W6]
- **dashboard/src/components/MessagesFeed.tsx** (modified): Uses `AgentMessageCard`. Removed unused `Paper` import. [W5]
- **dashboard/src/components/AgentsPanel.tsx** (modified): Uses `toErrorMessage`. [W6]
- **dashboard/src/hooks/useTaskActions.ts** (modified): Uses `toErrorMessage`. [W6]
- **dashboard/src/pages/OverviewPage.tsx** (modified): Uses `toErrorMessage`. [W6]
- **dashboard/src/layouts/DashboardLayout.tsx** (modified): Data-driven `NAV_ITEMS` array with `.map()` rendering. [W7]

## Design Decisions

- `useCursorPolling` uses refs for callback props to avoid re-triggering the polling effect when callbacks change identity.
- The `buildUrl` function is stored in a ref for the same reason -- only the explicit `deps` array triggers resets.
- `useMessages` keeps its `totalCount` state outside `useCursorPolling` since that's feature-specific, using the `onInitialLoad` callback to trigger the count fetch.
- `AgentMessageCard` accepts `paperRef` and `style` props for the highlight use case in MessagesFeed.
- `apiMutate` sets `Content-Type: application/json` for POST/PATCH even when body is undefined (matching original behavior).

## Build & Test Results
Pending initial build.

## Open Questions / Risks
- The `useCursorPolling` spread of `...deps` in the useEffect dependency array may trigger an ESLint exhaustive-deps warning. This is intentional for dynamic dependencies.
- `markRead` in `useChatMessages` now reads `messages` from the polling result rather than from `cursorRef` directly. This is functionally equivalent but relies on the `messages` array being up to date.

## Suggested Follow-ups
- None identified. All 7 violations are addressed.
