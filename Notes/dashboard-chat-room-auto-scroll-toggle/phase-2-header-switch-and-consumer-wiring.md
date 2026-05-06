# Phase 2 — Header Switch and consumer wiring

Part of [Dashboard Chat Room Auto-Scroll Toggle](./_index.md). See the index for the shared goal and context — this phase body assumes them.

**Outcome:** A Mantine `Switch` labelled "Auto-scroll" appears in the right group of the header `HealthBar`, next to the `Poll:` selector. Toggling it off causes both `ChatTimeline` and `MessagesFeed` to stop auto-scrolling on new messages and to surface their existing "Jump to latest" button instead. In `ChatTimeline`, the button additionally shows the per-room unread count (`Jump to latest (N)`). In `MessagesFeed`, the button keeps its plain `Jump to latest` label. Clicking the button or toggling auto-scroll back on jumps the active view to the bottom and resets that view's catch-up state. The toggle persists across reloads via `localStorage['dashboard.autoScroll']`.

**Types / APIs:**

```ts
// dashboard/src/components/HealthBar.tsx — props gain auto-scroll pair

interface HealthBarProps {
  health: HealthResponse | null;
  error: string | null;
  intervalMs: number;
  onIntervalChange: (ms: number) => void;
  autoScrollEnabled: boolean;                 // NEW
  onAutoScrollChange: (enabled: boolean) => void; // NEW
  middle?: ReactNode;
}
```

```ts
// dashboard/src/components/ChatTimeline.tsx — props gain unreadCount

interface ChatTimelineProps {
  roomId: string;
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onMarkRead: () => void;
  unreadCount: number; // NEW
}
```

`MessagesFeed`'s prop signature is unchanged — it reads `useAutoScrollPreference()` directly and passes `enabled` into the hook.

**Work:**

In [HealthBar.tsx](../../dashboard/src/components/HealthBar.tsx):

- Import `Switch` from `@mantine/core`.
- Add `autoScrollEnabled` and `onAutoScrollChange` to `HealthBarProps` and the function signature.
- In the right `Group`, before the `Poll:` block, add `<Text size="xs" c="dimmed">Auto-scroll:</Text>` and `<Switch size="xs" checked={autoScrollEnabled} onChange={(e) => onAutoScrollChange(e.currentTarget.checked)} />`.

In [DashboardLayout.tsx](../../dashboard/src/layouts/DashboardLayout.tsx):

- Import `useAutoScrollPreference` from `../hooks/useAutoScrollPreference.tsx`.
- Inside `DashboardLayout`, call `const { enabled: autoScrollEnabled, setEnabled: setAutoScrollEnabled } = useAutoScrollPreference();` next to the existing `usePollInterval()` call.
- Pass `autoScrollEnabled={autoScrollEnabled}` and `onAutoScrollChange={setAutoScrollEnabled}` to `<HealthBar />`.

In [ChatPage.tsx](../../dashboard/src/pages/ChatPage.tsx):

- Pass `unreadCount={chat.unreadCount}` to `<ChatTimeline />` alongside the existing props.

In [ChatTimeline.tsx](../../dashboard/src/components/ChatTimeline.tsx):

- Add `Switch` is **not** needed here; the global toggle lives in `HealthBar`.
- Add `unreadCount: number;` to `ChatTimelineProps` and destructure it.
- Import `useAutoScrollPreference` from `../hooks/useAutoScrollPreference.tsx`.
- Inside the component, call `const { enabled: autoScrollEnabled } = useAutoScrollPreference();`.
- Replace `useAutoScroll()` with `useAutoScroll({ enabled: autoScrollEnabled })`.
- Add an `onMarkReadRef` ref pointing at the latest `onMarkRead` callback (`onMarkReadRef.current = onMarkRead;` each render).
- Replace the existing `useEffect(() => { onMarkRead(); }, [roomId, onMarkRead])` (lines 41–43 on `main`) with a `useEffect` keyed on `[roomId]` only that calls `onMarkReadRef.current()`.
- Modify the `lastMessageId` effect (lines 45–50 on `main`): on a new trailing message, call `onNewContent()` unconditionally and call `onMarkReadRef.current()` only when `autoScrollEnabled` is `true`. Add `autoScrollEnabled` to the deps array.
- Add a separate `useEffect` keyed on `autoScrollEnabled` that compares against a `prevAutoScrollEnabledRef`: on `false → true`, call `onMarkReadRef.current()`. The `useAutoScroll` hook itself handles the scroll-to-sentinel on the same transition.
- Define `const handleJumpToLatest = useCallback(() => { jumpToLatest(); onMarkReadRef.current(); }, [jumpToLatest]);` and pass it to the existing catch-up `Button.onClick` instead of `jumpToLatest`.
- Change the `Transition mounted={showJumpToLatest}` prop to `mounted={showJumpToLatest || (!autoScrollEnabled && unreadCount > 0)}`.
- Change the `Button` content from the literal string `Jump to latest` to `{unreadCount > 0 ? \`Jump to latest (${unreadCount})\` : 'Jump to latest'}`.

In [MessagesFeed.tsx](../../dashboard/src/components/MessagesFeed.tsx):

- Import `useAutoScrollPreference` from `../hooks/useAutoScrollPreference.tsx`.
- Inside the component, call `const { enabled: autoScrollEnabled } = useAutoScrollPreference();`.
- Replace `useAutoScroll()` with `useAutoScroll({ enabled: autoScrollEnabled })`.
- No other changes — there is no unread count to surface, and the existing `Transition mounted={showJumpToLatest}` already mounts when the hook raises `showJumpToLatest` due to the `enabled` gate (the hook fires `setShowJumpToLatest(true)` on every new message while `enabled` is false).

**Worked example — toggle off in chat, three new messages, click button:**

1. Operator opens `/chat`, selects a room. `autoScrollEnabled = true`, `unreadCount = 0`. View auto-scrolls to latest as messages arrive; `unreadCount` stays at 0 because the `lastMessageId` effect calls `onMarkReadRef.current()` on every new message while `autoScrollEnabled` is true.
2. Operator clicks the header `Auto-scroll` Switch. `autoScrollEnabled = false`. localStorage now `"off"`. View stops moving.
3. Three new messages arrive. For each:
   - `onPollAppend` in `useChatMessages` sees `id > lastReadIdRef.current` → `unreadCount` increments (1, 2, 3).
   - `lastMessageId` effect fires, calls `onNewContent()`. The hook's `enabledRef.current` is `false` → it sets `showJumpToLatest = true` and returns without scrolling.
   - `autoScrollEnabled` is `false` → `onMarkReadRef.current()` is NOT called. `unreadCount` accumulates.
4. The catch-up `Transition` is mounted because `!autoScrollEnabled && unreadCount > 0` is true. The button reads `Jump to latest (3)`.
5. Operator clicks the button. `handleJumpToLatest` calls `jumpToLatest()` (scrolls to sentinel, sets `showJumpToLatest = false`) then `onMarkReadRef.current()` (sets `unreadCount = 0`). The `Transition` unmounts because both branches of `mounted` are now false.
6. Operator navigates to `/messages/general`. `autoScrollEnabled` is still `false` (global). New messages arrive there → view stays put, `Jump to latest` button mounts. Operator clicks it → view scrolls to bottom, button hides. No unread count surfaced (by design — `useMessages` has none).
7. Operator reloads the page. localStorage value is `"off"`. The Switch reads off on mount. Auto-scroll stays off everywhere.
8. Operator clicks the Switch on. `autoScrollEnabled = true`. localStorage now `"on"`. In whichever view is mounted, the `useAutoScroll` `enabled`-transition effect runs (`false → true`) → scrolls to sentinel, clears `showJumpToLatest`. In `ChatTimeline`, the `autoScrollEnabled`-transition effect runs → calls `onMarkReadRef.current()` to clear unread count.

**Verification:**

- `cd dashboard && npm run lint` passes.
- `cd dashboard && npm run build` succeeds.
- `cd dashboard && npm test` passes.
- Manual stack: start `server/` (`npm run dev`) and `dashboard/` (`npm run dev`). Need at least one busy chat room and an active flat messages stream.
  1. Confirm the `Auto-scroll` Switch appears in the header on every dashboard page (Overview, Messages, Logs, Chat, Teams).
  2. With Switch on (default), open `/chat`, select a busy room. Confirm view auto-scrolls and `unreadCount` stays at 0.
  3. Toggle Switch off. The viewport must not move as new messages arrive. The message under the operator's cursor stays in place.
  4. Confirm `Jump to latest (N)` appears at the bottom centre of the chat transcript with `N` matching the number of messages received since pausing.
  5. Click the button. View scrolls to the latest message, count clears, button hides.
  6. Repeat (3). Toggle Switch back on. View jumps to latest, count clears, button hides.
  7. Toggle Switch off again. Navigate to `/messages/general`. Confirm view stops auto-scrolling. After new messages arrive, the plain `Jump to latest` button appears at the bottom centre. Click it — view scrolls, button hides.
  8. Reload the browser. Confirm the Switch is still off and both views still respect it.
  9. Toggle Switch on. Reload. Confirm the Switch is on.
  10. In devtools, manually `localStorage.setItem('dashboard.autoScroll', 'garbage')` and reload. Confirm the Switch defaults to on (malformed value treated as default).
