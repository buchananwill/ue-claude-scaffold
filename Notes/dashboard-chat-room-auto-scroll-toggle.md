# Dashboard Chat Room Auto-Scroll Toggle

## Goal

Make auto-scroll a global, persistent dashboard preference: a single Switch in the header turns auto-scroll on or off everywhere it currently runs (chat rooms and the flat messages feed). When off, no view jumps to the latest message; an existing "Jump to latest" affordance becomes the catch-up control. The chat-room view additionally surfaces an unread-message count on its catch-up button so the operator can see how far behind they are without scrolling.

Resolves [issues/051-dashboard-room-auto-scroll-toggle.md](../issues/051-dashboard-room-auto-scroll-toggle.md).

## Context

Two components currently call [useAutoScroll](../dashboard/src/hooks/useAutoScroll.ts) and inherit the same UX problem: when new messages arrive while the operator is within 80px of the bottom, the view smooth-scrolls to the latest message. During a multi-agent design-team discussion (multiple messages per minute) this makes reading impossible — the view jumps before the operator finishes a sentence.

- [ChatTimeline](../dashboard/src/components/ChatTimeline.tsx) — chat-room transcript, real-time conversation.
- [MessagesFeed](../dashboard/src/components/MessagesFeed.tsx) — flat status feed (`/messages/$channel`), filtered by channel/agent/type.

Both share the same hook, the same auto-scroll behaviour, and the same UX failure. The toggle is therefore a global preference, persisted in localStorage so the operator's choice survives reloads.

The hook already has 80% of the machinery: `showJumpToLatest`, `jumpToLatest()`, and `onNewContent()`. When the operator is scrolled up, the view stays anchored and a "Jump to latest" button appears via Mantine `Transition`. Today that button is the only catch-up affordance — Phase 1's gate makes it appear whenever the global toggle is off and new content arrives, regardless of scroll position.

Where things live in the repo today:

- [main.tsx](../dashboard/src/main.tsx) wires `MantineProvider`, `Notifications`, `QueryClientProvider`, `PollIntervalProvider`, `RouterProvider`. New providers go here, inside `PollIntervalProvider`.
- [usePollInterval.tsx](../dashboard/src/hooks/usePollInterval.tsx) is the model for a tiny context + hook + provider trio (poll-interval preference).
- [DashboardLayout.tsx](../dashboard/src/layouts/DashboardLayout.tsx) renders the persistent header [HealthBar](../dashboard/src/components/HealthBar.tsx) — the right group of `HealthBar` already contains the `Poll:` `SegmentedControl`. The auto-scroll Switch lives next to it.
- [ChatPage.tsx](../dashboard/src/pages/ChatPage.tsx) owns `useChatMessages(activeRoomId)` and threads `unreadCount`, `markRead`, etc. into `ChatTimeline`.
- [useChatMessages.ts](../dashboard/src/hooks/useChatMessages.ts) maintains `unreadCount` per room. Its `markRead` callback today re-renders on every poll because its `useCallback` depends on `messages`. The existing `useEffect(() => { onMarkRead(); }, [roomId, onMarkRead])` in `ChatTimeline` therefore fires every poll and keeps `unreadCount` clamped to zero — fine before this change, but a problem once we want to accumulate unread state while paused.
- [useMessages.ts](../dashboard/src/hooks/useMessages.ts) (used by `MessagesFeed`) does **not** track unread count, and adding one is out of scope. `MessagesFeed`'s catch-up button keeps its existing "Jump to latest" label without a count — the issue's requirement is satisfied by either a count or a "new messages below" affordance, and the existing button serves the latter.

Mantine `Switch` is the standard toggle primitive in v8 and is not currently used in `dashboard/src/`. No new dependencies are needed.

The toggle's default is `on` (matches today's behaviour). The persistence key is `dashboard.autoScroll`. If parsing localStorage fails (missing, malformed), default to `on`.

<!-- PHASE-BOUNDARY -->

## Phase 1 — AutoScroll context, hook gate, stable markRead

**Outcome:** A new `AutoScrollProvider` is mounted at the dashboard root and exposes `{ enabled: boolean, setEnabled: (v: boolean) => void }` via `useAutoScrollPreference()`, persisting `enabled` to `localStorage['dashboard.autoScroll']`. `useAutoScroll` accepts an optional `{ enabled?: boolean }` argument that gates auto-scroll on new content; when `enabled` transitions `false → true`, the hook scrolls to the sentinel and clears `showJumpToLatest`. `useChatMessages.markRead` has stable identity across polls. No consumer reads the new context yet — `ChatTimeline` and `MessagesFeed` continue to call `useAutoScroll()` with no argument and behave exactly as on `main`.

**Types / APIs:**

```ts
// dashboard/src/hooks/useAutoScrollPreference.tsx (new file)

interface AutoScrollContextValue {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
}

export function AutoScrollProvider({ children }: { children: ReactNode }): JSX.Element;
export function useAutoScrollPreference(): AutoScrollContextValue;
```

```ts
// dashboard/src/hooks/useAutoScroll.ts

interface UseAutoScrollOptions {
  /**
   * When false, onNewContent skips auto-scrolling and always raises the
   * jump-to-latest indicator instead. Defaults to true.
   */
  enabled?: boolean;
}

export function useAutoScroll(
  options?: UseAutoScrollOptions,
): UseAutoScrollResult;
```

The `UseAutoScrollResult` shape (`viewportRef`, `sentinelRef`, `isAtBottom`, `showJumpToLatest`, `jumpToLatest`, `onNewContent`) is unchanged.

```ts
// dashboard/src/hooks/useChatMessages.ts — markRead becomes identity-stable

const markRead: () => void; // useCallback with empty deps, reads messages via ref
```

**Persistence contract:**

- localStorage key: `dashboard.autoScroll`. Stored value: the literal string `"on"` or `"off"`.
- On mount: read the key. If value is `"off"`, initialise `enabled = false`. Any other value (including missing or malformed) → `enabled = true`.
- On `setEnabled(v)`: write `"on"` or `"off"` accordingly. Wrap the write in `try/catch` — Safari private mode and storage-disabled environments throw on `setItem`. Failures are silent; in-memory state still updates.

**Work:**

- Create [dashboard/src/hooks/useAutoScrollPreference.tsx](../dashboard/src/hooks/useAutoScrollPreference.tsx). Mirror the structure of [usePollInterval.tsx](../dashboard/src/hooks/usePollInterval.tsx): a `createContext` with a sensible default, an `AutoScrollProvider` component using `useState` initialised from `localStorage`, and a `useAutoScrollPreference()` hook. Wrap the `setEnabled` callback so it persists to localStorage in `try/catch`.
- In [main.tsx](../dashboard/src/main.tsx): import `AutoScrollProvider` and wrap it inside `PollIntervalProvider` (so it sits below `QueryClientProvider` but above `RouterProvider`).
- In [useAutoScroll.ts](../dashboard/src/hooks/useAutoScroll.ts):
  - Add the `UseAutoScrollOptions` interface above `UseAutoScrollResult`.
  - Change the function signature to `useAutoScroll(options?: UseAutoScrollOptions)`. Read `const enabled = options?.enabled ?? true;`.
  - Add `const enabledRef = useRef(enabled); enabledRef.current = enabled;` alongside the existing refs.
  - Inside `onNewContent`, branch on `enabledRef.current` first: if `false`, call `setShowJumpToLatest(true)` and return. Otherwise keep the existing branch on `isAtBottomRef.current`.
  - Add a `useEffect` keyed on `enabled` that compares against a `prevEnabledRef`. When the value transitions from `false` to `true`, call `requestAnimationFrame(() => sentinelRef.current?.scrollIntoView({ behavior: 'smooth' }))` and `setShowJumpToLatest(false)`. Update `prevEnabledRef.current` at the end of the effect.
- In [useChatMessages.ts](../dashboard/src/hooks/useChatMessages.ts):
  - Add `const messagesRef = useRef(messages); messagesRef.current = messages;` after the `useCursorPolling` call.
  - Replace the `markRead` `useCallback` body to read from `messagesRef.current`, and change its deps array to `[]`. The behaviour is otherwise identical: write the trailing message id into `lastReadIdRef` and call `setUnreadCount(0)`.

**Verification:**

- `cd dashboard && npm run lint` passes.
- `cd dashboard && npm run build` succeeds (TypeScript + Vite).
- `cd dashboard && npm test` passes (the existing suite must not regress; no new tests required).
- Open the dashboard. Navigate to `/chat` and `/messages/general`. Confirm both views behave exactly as on `main` — auto-scroll on new messages, "Jump to latest" appears when scrolled up.
- In the browser devtools, confirm `localStorage.getItem('dashboard.autoScroll')` is `null` (no consumer is yet writing it).

<!-- PHASE-BOUNDARY -->

## Phase 2 — Header Switch and consumer wiring

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

In [HealthBar.tsx](../dashboard/src/components/HealthBar.tsx):

- Import `Switch` from `@mantine/core`.
- Add `autoScrollEnabled` and `onAutoScrollChange` to `HealthBarProps` and the function signature.
- In the right `Group`, before the `Poll:` block, add `<Text size="xs" c="dimmed">Auto-scroll:</Text>` and `<Switch size="xs" checked={autoScrollEnabled} onChange={(e) => onAutoScrollChange(e.currentTarget.checked)} />`.

In [DashboardLayout.tsx](../dashboard/src/layouts/DashboardLayout.tsx):

- Import `useAutoScrollPreference` from `../hooks/useAutoScrollPreference.tsx`.
- Inside `DashboardLayout`, call `const { enabled: autoScrollEnabled, setEnabled: setAutoScrollEnabled } = useAutoScrollPreference();` next to the existing `usePollInterval()` call.
- Pass `autoScrollEnabled={autoScrollEnabled}` and `onAutoScrollChange={setAutoScrollEnabled}` to `<HealthBar />`.

In [ChatPage.tsx](../dashboard/src/pages/ChatPage.tsx):

- Pass `unreadCount={chat.unreadCount}` to `<ChatTimeline />` alongside the existing props.

In [ChatTimeline.tsx](../dashboard/src/components/ChatTimeline.tsx):

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

In [MessagesFeed.tsx](../dashboard/src/components/MessagesFeed.tsx):

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
