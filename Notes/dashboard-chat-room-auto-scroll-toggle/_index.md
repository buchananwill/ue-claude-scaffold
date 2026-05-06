# Dashboard Chat Room Auto-Scroll Toggle

## Goal

Make auto-scroll a global, persistent dashboard preference: a single Switch in the header turns auto-scroll on or off everywhere it currently runs (chat rooms and the flat messages feed). When off, no view jumps to the latest message; an existing "Jump to latest" affordance becomes the catch-up control. The chat-room view additionally surfaces an unread-message count on its catch-up button so the operator can see how far behind they are without scrolling.

Resolves [issues/051-dashboard-room-auto-scroll-toggle.md](../../issues/051-dashboard-room-auto-scroll-toggle.md).

## Context

Two components currently call [useAutoScroll](../../dashboard/src/hooks/useAutoScroll.ts) and inherit the same UX problem: when new messages arrive while the operator is within 80px of the bottom, the view smooth-scrolls to the latest message. During a multi-agent design-team discussion (multiple messages per minute) this makes reading impossible — the view jumps before the operator finishes a sentence.

- [ChatTimeline](../../dashboard/src/components/ChatTimeline.tsx) — chat-room transcript, real-time conversation.
- [MessagesFeed](../../dashboard/src/components/MessagesFeed.tsx) — flat status feed (`/messages/$channel`), filtered by channel/agent/type.

Both share the same hook, the same auto-scroll behaviour, and the same UX failure. The toggle is therefore a global preference, persisted in localStorage so the operator's choice survives reloads.

The hook already has 80% of the machinery: `showJumpToLatest`, `jumpToLatest()`, and `onNewContent()`. When the operator is scrolled up, the view stays anchored and a "Jump to latest" button appears via Mantine `Transition`. Today that button is the only catch-up affordance — Phase 1's gate makes it appear whenever the global toggle is off and new content arrives, regardless of scroll position.

Where things live in the repo today:

- [main.tsx](../../dashboard/src/main.tsx) wires `MantineProvider`, `Notifications`, `QueryClientProvider`, `PollIntervalProvider`, `RouterProvider`. New providers go here, inside `PollIntervalProvider`.
- [usePollInterval.tsx](../../dashboard/src/hooks/usePollInterval.tsx) is the model for a tiny context + hook + provider trio (poll-interval preference).
- [DashboardLayout.tsx](../../dashboard/src/layouts/DashboardLayout.tsx) renders the persistent header [HealthBar](../../dashboard/src/components/HealthBar.tsx) — the right group of `HealthBar` already contains the `Poll:` `SegmentedControl`. The auto-scroll Switch lives next to it.
- [ChatPage.tsx](../../dashboard/src/pages/ChatPage.tsx) owns `useChatMessages(activeRoomId)` and threads `unreadCount`, `markRead`, etc. into `ChatTimeline`.
- [useChatMessages.ts](../../dashboard/src/hooks/useChatMessages.ts) maintains `unreadCount` per room. Its `markRead` callback today re-renders on every poll because its `useCallback` depends on `messages`. The existing `useEffect(() => { onMarkRead(); }, [roomId, onMarkRead])` in `ChatTimeline` therefore fires every poll and keeps `unreadCount` clamped to zero — fine before this change, but a problem once we want to accumulate unread state while paused.
- [useMessages.ts](../../dashboard/src/hooks/useMessages.ts) (used by `MessagesFeed`) does **not** track unread count, and adding one is out of scope. `MessagesFeed`'s catch-up button keeps its existing "Jump to latest" label without a count — the issue's requirement is satisfied by either a count or a "new messages below" affordance, and the existing button serves the latter.

Mantine `Switch` is the standard toggle primitive in v8 and is not currently used in `dashboard/src/`. No new dependencies are needed.

The toggle's default is `on` (matches today's behaviour). The persistence key is `dashboard.autoScroll`. If parsing localStorage fails (missing, malformed), default to `on`.

## Phases

1. [Phase 1 — AutoScroll context, hook gate, stable markRead](./phase-1-autoscroll-context-hook-gate-stable-markread.md)
2. [Phase 2 — Header Switch and consumer wiring](./phase-2-header-switch-and-consumer-wiring.md)
