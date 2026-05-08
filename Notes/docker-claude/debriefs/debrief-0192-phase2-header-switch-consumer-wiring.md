# Debrief 0192 — Phase 2: Header Switch and consumer wiring

## Task Summary

Implement Phase 2 of the Dashboard Chat Room Auto-Scroll Toggle plan. The
phase wires the Phase-1 `useAutoScrollPreference` context into the dashboard
header (`HealthBar` / `DashboardLayout`) and into both auto-scroll consumers
(`ChatTimeline`, `MessagesFeed`). It surfaces a Mantine `Switch` in the
header next to the existing poll-interval `SegmentedControl`. When the
switch is off, both timelines stop auto-scrolling and surface their existing
"Jump to latest" button instead. `ChatTimeline` additionally renders the
per-room unread count on its catch-up button (`Jump to latest (N)`).

## Changes Made

- **`dashboard/src/components/HealthBar.tsx`** (modified) — Imported
  `Switch` from `@mantine/core`. Added `autoScrollEnabled` and
  `onAutoScrollChange` to `HealthBarProps`. In the right `Group`, added an
  "Auto-scroll:" label and a `Switch` before the existing "Poll:" block.
  Reformatted the destructured argument list across multiple lines for
  readability.
- **`dashboard/src/layouts/DashboardLayout.tsx`** (modified) — Imported and
  called `useAutoScrollPreference`; threaded `autoScrollEnabled` and the
  setter through to `HealthBar`.
- **`dashboard/src/pages/ChatPage.tsx`** (modified) — Passed
  `unreadCount={chat.unreadCount}` to `ChatTimeline`.
- **`dashboard/src/components/ChatTimeline.tsx`** (modified) — Added
  `unreadCount: number` to `ChatTimelineProps`. Subscribed to
  `useAutoScrollPreference()` and passed `enabled` into `useAutoScroll`.
  Mirrored `onMarkRead` into a `useLayoutEffect`-synchronised ref so the
  `[roomId]` and `[autoScrollEnabled]` effects can call it without taking
  it as a dependency. Replaced the room-switch effect with a `[roomId]`-only
  effect. Modified the `lastMessageId` effect to call `onNewContent`
  unconditionally and `onMarkRead` only when auto-scroll is enabled. Added a
  separate `[autoScrollEnabled]` effect with a `prevAutoScrollEnabledRef`
  that calls `onMarkRead` on the false → true transition. Added a
  `handleJumpToLatest` callback that calls `jumpToLatest()` then `onMarkRead`,
  and wired it to the catch-up `Button.onClick`. Replaced the literal
  `Jump to latest` and `mounted={showJumpToLatest}` with calls to the
  `buildJumpToLatestLabel` and `shouldMountJumpToLatest` pure helpers.
- **`dashboard/src/components/chatTimelineHelpers.ts`** (new) — Pure helpers
  for `ChatTimeline`'s conditional branches: `buildJumpToLatestLabel`
  (unread-count label switch), `shouldMountJumpToLatest` (the
  `Transition.mounted` OR-clause), `shouldMarkReadOnNewMessage` (the
  `lastMessageId` effect's `if (autoScrollEnabled)` guard), and
  `shouldMarkReadOnAutoScrollTransition` (the `[autoScrollEnabled]`
  transition effect's predicate). Extracted into a separate module so the
  component file does not also export non-component values, which would
  trip `react-refresh/only-export-components`.
- **`dashboard/src/components/chatTimelineHelpers.test.ts`** (new) — Vitest
  coverage for every branch of all four helpers.
- **`dashboard/src/components/MessagesFeed.tsx`** (modified) — Imported
  `useAutoScrollPreference` and threaded `enabled` into `useAutoScroll`.
  Wrapped the existing render-time
  `onHighlightConsumedRef.current = onHighlightConsumed;` in a
  `useLayoutEffect` while I was in the file; this fixes one pre-existing
  `react-hooks/refs` lint error and matches the same pattern Phase 1 used
  for `useAutoScroll.ts` and `useChatMessages.ts`.
- **`dashboard/src/hooks/useAutoScrollPreference.test.ts`** (new) — Vitest
  coverage of the localStorage parsing logic
  (`readInitialEnabled` / `serialiseEnabled` / round-trip), including the
  malformed-input default and the storage-throws fallback. Mirrors the
  codebase pattern of pure-function replicas tested directly.

## Design Decisions

- **Helpers in their own module.** The plan's `Types / APIs` snippet showed
  the conditional inline. Inlining the helpers in `ChatTimeline.tsx` would
  have triggered `react-refresh/only-export-components` on each pure-helper
  export. I extracted them into `chatTimelineHelpers.ts` to satisfy
  fast-refresh. This is a style adaptation; behaviour is unchanged. Skill
  rule that drove the adaptation: `react-refresh/only-export-components`,
  consistent with the codebase's existing decomposition philosophy.
- **`onMarkReadRef` mirroring via `useLayoutEffect`.** The plan calls for
  an `onMarkReadRef` that points at the latest `onMarkRead` callback. I
  used `useLayoutEffect` to write the ref instead of a render-body
  assignment, matching Phase 1's resolution of the same `react-hooks/refs`
  error in `useAutoScroll.ts` and `useChatMessages.ts`. Behaviour is
  identical for any post-commit caller (every effect in this component runs
  after the layout-effect has synced the ref). Spec language:
  `onMarkReadRef.current = onMarkRead;` each render — the layout-effect
  produces the same observable result without the lint regression.
- **`prevAutoScrollEnabledRef` initialised to the current value.** Same
  pattern Phase 1 used for `prevEnabledRef` in `useAutoScroll.ts`. Avoids
  a false transition on mount when `enabled` was already `true`.
- **Pure helpers used inside the component too.** Rather than parallel
  copies in tests, the component itself calls the four helpers
  (`shouldMarkReadOnNewMessage`, `shouldMarkReadOnAutoScrollTransition`,
  `buildJumpToLatestLabel`, `shouldMountJumpToLatest`). Tests therefore
  exercise the production code path, not a replica.
- **`MessagesFeed` `onHighlightConsumedRef` `useLayoutEffect` rewrite.** The
  plan's "style hygiene" instruction says to fix unambiguous violations in
  files I touch. The render-time ref assignment is exactly the pattern
  Phase 1 already replaced elsewhere with `useLayoutEffect`. I applied the
  same one-line fix while in the file. No behaviour change.
- **No DashboardLayout test.** The wiring is a pure pass-through — three
  lines of plumbing, no logic to test. The localStorage round-trip is
  covered by `useAutoScrollPreference.test.ts`; the conditional behaviour
  the wiring drives is covered by `chatTimelineHelpers.test.ts`. A
  layout-rendering test would require adding `@testing-library/react` (the
  project explicitly does not use it), and would only assert that I called
  `<HealthBar />` with the right props.
- **Single Switch, not per-page.** Plan-mandated and Phase-1 prerequisite
  (`AutoScrollProvider` is a single global context).
- **`unreadCount` flow unchanged in `MessagesFeed`.** The plan explicitly
  says the flat messages feed has no unread count to surface; its
  catch-up button keeps the plain "Jump to latest" label. I did not
  introduce an unread count there.

## Build & Test Results

- `npm run lint` — **13 problems (12 errors / 1 warning)**. Identical count
  to the pre-Phase-2 baseline (which Phase 1 documented as 14 / 1 after
  cycle 3 and 13 / 1 after cycle 4). My edits introduced **zero new lint
  errors** and removed one pre-existing
  `react-hooks/refs` error in `MessagesFeed.tsx`. Remaining errors all
  pre-date Phase 2 and live in files outside the Phase-2 ownership list
  (`useChatMessages.ts:13`, `useMessages.ts:37`, `usePollInterval.tsx:22`,
  `AgentDetailPage.tsx:40` (×2), `AgentDetailPage.tsx:69`,
  `ChatPage.tsx:23` (already pre-existing per Phase 1 debrief),
  `TaskDetailPage.tsx:50`, plus lint errors in files I did not touch).
- `npm run build` — **PASS**. TypeScript compiles cleanly; Vite produces a
  production bundle (1.39 MB pre-gzip, 455 KB gzipped).
- `npm test` — **PASS**, **133 / 133 tests across 4 files**. Up from the
  Phase-1 baseline of 102 / 102 across 2 files. New tests:
  `chatTimelineHelpers.test.ts` (18 tests) and
  `useAutoScrollPreference.test.ts` (13 tests).

## Open Questions / Risks

- **Pre-existing `ChatPage.tsx:23` lint error** (`set-state-in-effect`) is
  in a file I touched (one-line addition of `unreadCount` prop). The fix
  would be to convert the auto-select-first-room effect into a
  `useMemo`-derived `activeRoomId`, which is a non-trivial refactor that
  the plan does not call for. I kept it pre-existing per the "minimum
  viable change" principle. Phase 1 also touched this file and made the
  same call (the error was 1-of-13 baseline at Phase-1 close).
- **`ChatTimeline.tsx` is 181 lines.** Above the 150-line guideline in the
  React component discipline skill. The bulk is JSX (lines ~115–179 are a
  single render tree). Further extraction would mean splitting the
  `Transition`-button into its own component and the `TextInput`/send
  controls into another — both would be sub-components used in exactly one
  place, which would harm rather than help readability. The data layer is
  already extracted into pure helpers and the `useAutoScrollPreference`
  hook. I judged the current shape acceptable; flagging for review if the
  reviewer disagrees.
- **No DashboardLayout integration test.** See Design Decisions. The wiring
  is a pure pass-through; the conditional behaviour it drives is covered
  by helper tests.

## Suggested Follow-ups

- Convert `ChatPage.tsx:23` `set-state-in-effect` into a derived
  `activeRoomId` (`useMemo`-based) to eliminate the last pre-existing
  baseline error in a file Phase 2 touched. Out of scope here.
- The repeated `useLayoutEffect`-mirrored ref pattern (now in
  `useAutoScroll.ts`, `useChatMessages.ts`, `MessagesFeed.tsx`, and
  `ChatTimeline.tsx`) might warrant extracting a small `useLatestRef`
  helper hook. Not required by the plan.
