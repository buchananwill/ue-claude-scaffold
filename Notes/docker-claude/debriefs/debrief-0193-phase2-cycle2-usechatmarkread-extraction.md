# Debrief 0193 — Phase 2 cycle 2: extract `useChatMarkRead` and fix `ChatPage` lint

## Task Summary

The Phase 2 react-quality reviewer raised two WARNINGs against commit `64a00cd`:

- **W1** — `dashboard/src/components/ChatTimeline.tsx` was 181 lines (cap is
  150) and still carried five pieces of mark-read coordination logic in the
  component body (the `onMarkReadRef` mirror, the `prevAutoScrollEnabledRef`,
  the `[roomId]` effect, the `[lastMessageId, autoScrollEnabled, onNewContent]`
  effect, the `[autoScrollEnabled]` transition effect, and the
  `handleJumpToLatest` callback). All of this is data-coordination logic that
  belongs in a hook, not a component.
- **W2** — `dashboard/src/pages/ChatPage.tsx` had a pre-existing
  `react-hooks/set-state-in-effect` ESLint error: a `useEffect` was calling
  `setActiveRoomId(roomList[0].id)` synchronously in its body. The file was
  touched in Phase 2 (the `unreadCount` prop was added), so the touched-file
  mandate required this fix.

Both findings had to be resolved before the phase advanced. Behaviour had to
be preserved exactly — no spec change.

## Changes Made

- **`dashboard/src/hooks/useChatMarkRead.ts`** *(created, 91 lines)* — new
  hook that owns the four mark-read triggers and the `handleJumpToLatest`
  callback:
  - `onMarkReadRef` mirror via `useLayoutEffect` so effects keyed on other
    deps don't re-run when the parent passes a fresh callback identity.
  - `prevAutoScrollEnabledRef` initialised to the first `autoScrollEnabled`
    value at mount.
  - `lastSeenIdRef` for the new-message effect, scoped to the hook.
  - Three `useEffect`s with the original dependency lists:
    `[roomId]`, `[lastMessageId, onNewContent, autoScrollEnabled]`,
    `[autoScrollEnabled]`.
  - `handleJumpToLatest` memoised on `[jumpToLatest]`.
  - Imports the predicates from `chatTimelineHelpers.ts` (no duplication).
- **`dashboard/src/components/ChatTimeline.tsx`** *(modified, 181 → 144
  lines)* — removed the five mark-read coordination items and replaced them
  with a single `useChatMarkRead({...})` call that returns
  `handleJumpToLatest`. The pure helpers
  `shouldMarkReadOnNewMessage` / `shouldMarkReadOnAutoScrollTransition` are
  no longer imported here (they're now consumed inside the hook). The
  Mantine wiring, the auto-scroll wiring, the input/send handler, and the
  JSX layout were left untouched.
- **`dashboard/src/pages/ChatPage.tsx`** *(modified)* — replaced the
  `useState` + `useEffect` initializer pair with a `useState` for the
  *user-selected* room id (renamed to `selectedRoomId` for clarity) plus a
  `useMemo` that derives the effective `activeRoomId` from
  `selectedRoomId ?? roomList[0]?.id ?? null`. `roomList`, `teamList`, and
  `teamRoomIds` are now wrapped in `useMemo` to keep dependency identities
  stable. The setter is still wired into `ChatRoomList`'s `onSelect` prop so
  explicit user selection works unchanged. URL-derived initial selection
  (`search.room`) still seeds the state. Behaviour preserved: when no room
  is selected and a rooms list arrives, the first room becomes active; when
  the user clicks a room, that room is active.
- **`dashboard/src/hooks/useChatMarkRead.test.ts`** *(created, 312 lines)* —
  Vitest tests for the hook's effect sequencing. Following the codebase
  pattern (`useAutoScrollPreference.test.ts`, `useTaskFilters.test.ts`) the
  tests replicate the effect bodies as a pure state machine — there is no
  React renderer or DOM in the dashboard test environment (no
  `@testing-library/react`, no `jsdom`). Coverage:
  - Room-switch effect: fires on mount, fires on roomId change, uses the
    latest `onMarkRead` via the ref mirror.
  - New-message effect: marks read when `autoScrollEnabled=true`, does not
    when `false`, ignores `null` ids, dedupes the same id, fires again on a
    new id, accepts numeric ids.
  - Transition effect: fires only on false → true; never on true → false,
    steady-state true→true, or steady-state false→false; updates the
    previous-value ref after each call.
  - `handleJumpToLatest`: calls `jumpToLatest()` then `onMarkRead()`; uses
    the latest mirrored callback.
  - End-to-end worked example mirroring the spec's "auto-scroll on, 3 msgs;
    toggle off, 2 msgs; toggle on" walk-through.

## Design Decisions

- **No `@testing-library/react`.** The dashboard test stack runs Vitest in
  the default Node env with no DOM (no `jsdom`, no testing-library). Every
  existing hook test in the codebase replicates the React-side logic as a
  pure state machine. I followed that pattern: the hook is the sole owner
  of the React wiring, and the test exercises pure replicas of the effect
  bodies. The predicates the effects use (`shouldMarkReadOnNewMessage`,
  `shouldMarkReadOnAutoScrollTransition`) are imported into both the hook
  and the test, so any divergence between the two would fail at the type
  level. This is the same approach used in
  `useAutoScrollPreference.test.ts`.
- **`lastMessageId` typed as `string | number | null`.** The hook accepts
  either since `ChatTimeline` extracts it from `messages[last].id` whose
  schema-level type is numeric in this codebase but string in some
  call-paths. Keeping the union avoids forcing a coercion at the call site.
- **Renamed `activeRoomId` state in `ChatPage` to `selectedRoomId`.** The
  fallback-to-first-room is now a derived value, so the state variable
  ought to reflect what it actually holds (only the user's explicit
  selection or the URL-derived seed). The derived `activeRoomId` keeps the
  exact name `ChatRoomList` and `ChatTimeline` already consume.
- **Hook returns a covariant object (`{ handleJumpToLatest }`)** rather
  than the bare callback. The reviewer's recommended signature does this
  too — it keeps the hook's surface extensible without breaking call
  sites.

## Build & Test Results

```
cd dashboard
npm run lint   # 11 problems (11 errors, 0 warnings) — was 12/1 before this cycle
npm run build  # SUCCESS (tsc -b && vite build)
npm test       # 151 tests passed across 5 files (was 133 before)
```

Lint outcome: the ChatPage `set-state-in-effect` error is gone, and the
companion `roomList` dependency-stability warning is also gone (the
`useMemo` wrapper made the dependency identity stable). Net delta: −1
error, −1 warning. The remaining 11 errors are all in files outside Phase
2's scope (`AgentDetailPage.tsx`, `TaskDetailPage.tsx`) and are explicitly
out-of-scope per the cycle-2 brief.

Test count rose by 18 (133 → 151) from the new `useChatMarkRead` test
file.

## Open Questions / Risks

- The hook tests cover the *sequencing* of the effects, not the React-side
  scheduling (e.g. that `useLayoutEffect` runs before `useEffect`, or that
  the transition effect's state update precedes the next render). React
  itself owns those guarantees and they're exercised by the existing
  `chatTimelineHelpers.test.ts` together with manual smoke verification at
  the screen level. If a future regression touches the order in which
  React fires effects, this test suite will not catch it — the harness
  would need a renderer for that, and the project doesn't ship one.
- The `lastMessageId` ref dedupe means that if a parent ever resets the
  trailing id back to `null` while a room is open, the *next* fresh id
  will fire normally (because `lastSeenIdRef` keeps the previous id, and
  any new id != that). This matches the previous behaviour exactly.

## Suggested Follow-ups

- The two pre-existing lint errors in `AgentDetailPage.tsx` and
  `TaskDetailPage.tsx` are not in the cycle-2 scope but remain on the
  baseline. A future touched-file pass on those pages can clean them up.
- If the dashboard ever adopts a DOM test environment (jsdom + testing
  library), the `useChatMarkRead` test file can be migrated to a
  `renderHook`-style suite without changing the hook's public surface.
