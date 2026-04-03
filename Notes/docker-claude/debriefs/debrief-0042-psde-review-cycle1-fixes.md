# Debrief 0042 -- PSDE Classification Review Cycle 1 Fixes

## Task Summary
Fix all blocking and warning items from the decomposition review (cycle 1). Eight files needed changes across the dashboard.

## Changes Made
- **dashboard/src/hooks/useChatMessages.ts** -- Added useEffect to reset unreadCount and lastReadIdRef when roomId changes (B1 fix).
- **dashboard/src/components/AgentMessageCard.tsx** -- Replaced `mb={4}` with `mb="xs"`, replaced `style={{ maxWidth: 200 }}` with `maw={200}` prop (B2 fix).
- **dashboard/src/components/ChatTimeline.tsx** -- Replaced `bottom: 16` with `bottom: 'var(--mantine-spacing-md)'` (B2 fix).
- **dashboard/src/components/MessagesFeed.tsx** -- Replaced `bottom: 16` with `bottom: 'var(--mantine-spacing-md)'` (B2 fix).
- **dashboard/src/hooks/useMessages.ts** -- Added explanatory comment to `.catch(() => {})` (W1 fix).
- **dashboard/src/layouts/DashboardLayout.tsx** -- Narrowed `as any` to `as unknown as Record<string, string>` (W2 fix).
- **dashboard/src/hooks/useCursorPolling.ts** -- Added `setError(toErrorMessage(err))` to loadOlder catch block (W3 fix).
- **dashboard/src/components/MarkdownContent.tsx** -- Replaced `{...rest}` spread on img with explicit `alt` and `title` props (W4 fix).

## Design Decisions
- W2: Used `as unknown as Record<string, string>` because a direct cast from `{ params: Record<string, string> }` to `Record<string, string>` fails TS overlap checks. The double cast through `unknown` is standard practice for TanStack Router param forwarding workarounds.
- Did NOT change import extensions per explicit instruction (ESM .ts/.tsx is correct for this Vite project).

## Build & Test Results
- Build: SUCCESS (`npm run build` in dashboard/)
- No test suite exists for dashboard components.

## Open Questions / Risks
None.

## Suggested Follow-ups
None.
