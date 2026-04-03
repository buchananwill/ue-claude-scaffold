# Debrief 0043 -- PSDE Review Cycle 2 Fixes

## Task Summary

Apply three small fixes from decomposition review cycle 2: remove unsafe `...rest` spread on anchor elements, add null guard for roomId, and add length guard on onInitialLoad items access.

## Changes Made

- **dashboard/src/components/MarkdownContent.tsx** -- Removed `...rest` spread from the `<a>` renderer. Now only passes `href`, `target`, `rel`, and `children` explicitly, matching the `<img>` pattern already in place.
- **dashboard/src/hooks/useChatMessages.ts** -- Added `if (roomId == null) throw new Error('roomId is null')` guard before using roomId in buildUrl, replacing the non-null assertion. Added `if (items.length > 0)` guard around the `onInitialLoad` callback body to prevent accessing an empty array.

## Design Decisions

- For W1, chose the simplest approach: destructure only `href` and `children` in the function signature, dropping `...rest` entirely. No anchor-specific props (className, title) are needed by the markdown renderer.
- For W2, used a throwing guard rather than a silent return, since `enabled: roomId != null` should prevent this path. A throw makes the invariant violation visible.

## Build & Test Results

- Dashboard build: SUCCESS (tsc + vite, no errors)

## Open Questions / Risks

None.

## Suggested Follow-ups

None.
