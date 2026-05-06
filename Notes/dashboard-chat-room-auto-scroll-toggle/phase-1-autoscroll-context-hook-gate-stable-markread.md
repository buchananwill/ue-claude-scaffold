# Phase 1 — AutoScroll context, hook gate, stable markRead

Part of [Dashboard Chat Room Auto-Scroll Toggle](./_index.md). See the index for the shared goal and context — this phase body assumes them.

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

- Create [dashboard/src/hooks/useAutoScrollPreference.tsx](../../dashboard/src/hooks/useAutoScrollPreference.tsx). Mirror the structure of [usePollInterval.tsx](../../dashboard/src/hooks/usePollInterval.tsx): a `createContext` with a sensible default, an `AutoScrollProvider` component using `useState` initialised from `localStorage`, and a `useAutoScrollPreference()` hook. Wrap the `setEnabled` callback so it persists to localStorage in `try/catch`.
- In [main.tsx](../../dashboard/src/main.tsx): import `AutoScrollProvider` and wrap it inside `PollIntervalProvider` (so it sits below `QueryClientProvider` but above `RouterProvider`).
- In [useAutoScroll.ts](../../dashboard/src/hooks/useAutoScroll.ts):
  - Add the `UseAutoScrollOptions` interface above `UseAutoScrollResult`.
  - Change the function signature to `useAutoScroll(options?: UseAutoScrollOptions)`. Read `const enabled = options?.enabled ?? true;`.
  - Add `const enabledRef = useRef(enabled); enabledRef.current = enabled;` alongside the existing refs.
  - Inside `onNewContent`, branch on `enabledRef.current` first: if `false`, call `setShowJumpToLatest(true)` and return. Otherwise keep the existing branch on `isAtBottomRef.current`.
  - Add a `useEffect` keyed on `enabled` that compares against a `prevEnabledRef`. When the value transitions from `false` to `true`, call `requestAnimationFrame(() => sentinelRef.current?.scrollIntoView({ behavior: 'smooth' }))` and `setShowJumpToLatest(false)`. Update `prevEnabledRef.current` at the end of the effect.
- In [useChatMessages.ts](../../dashboard/src/hooks/useChatMessages.ts):
  - Add `const messagesRef = useRef(messages); messagesRef.current = messages;` after the `useCursorPolling` call.
  - Replace the `markRead` `useCallback` body to read from `messagesRef.current`, and change its deps array to `[]`. The behaviour is otherwise identical: write the trailing message id into `lastReadIdRef` and call `setUnreadCount(0)`.

**Verification:**

- `cd dashboard && npm run lint` passes.
- `cd dashboard && npm run build` succeeds (TypeScript + Vite).
- `cd dashboard && npm test` passes (the existing suite must not regress; no new tests required).
- Open the dashboard. Navigate to `/chat` and `/messages/general`. Confirm both views behave exactly as on `main` — auto-scroll on new messages, "Jump to latest" appears when scrolled up.
- In the browser devtools, confirm `localStorage.getItem('dashboard.autoScroll')` is `null` (no consumer is yet writing it).
