# Debrief 0213 — Phase 8 cycle 5: decomposition pass

## Task Summary

Address the decomposition reviewer's WARNING findings on the Phase 8 dashboard
work. The pass is pure refactor:

- W1: split the 733-line `TaskDetailPage.tsx` into per-section components.
- W2: deduplicate `severityColor`, `VERDICT_COLORS`, and the
  `'BLOCKING' | 'NOTE'` literal between `TaskDetailPage` and `FindingsPage`.
- W3: collapse the three identical loading/error/empty guards in the
  `FindingsPage` sidebar panels into a `QueryPanel` wrapper.
- W4: extract the `FindingHighlightLink` / `TaskHighlightLink` primitives so
  the cross-route `<Link>` callbacks only need one
  `@typescript-eslint/no-explicit-any` disable.

No behavior changes — verdict colours, severity colours, finding link
targets, panel loading / error / empty branches, and FSM rendering all
preserved bit-for-bit.

## Changes Made

- `dashboard/src/constants/finding-styling.ts` (new): exports `Severity`
  alias (= `ReviewFinding['severity']`), `SEVERITY_COLORS`, `VERDICT_COLORS`,
  and the legacy `severityColor()` helper for incremental migration.
- `dashboard/src/components/FindingLinks.tsx` (new): `FindingHighlightLink`
  (severity-optional) and `TaskHighlightLink` cross-route Link wrappers.
  The remaining `eslint-disable` for `prev: any` is now contained at one
  call site rather than three.
- `dashboard/src/components/QueryPanel.tsx` (new): uniform
  loading / error / empty wrapper around the children-as-success-state
  pattern.
- `dashboard/src/components/TaskFsmStrip.tsx` (new): extracted from
  TaskDetailPage. No logic change.
- `dashboard/src/components/TaskReviewsSection.tsx` (new): houses
  `TaskReviewsSection`, `CycleBlock`, `ReviewRunItem`, `FindingsTable`,
  and the local `severityOrdinalPrefix` helper. The "store previous prop"
  pattern in `CycleBlock` is preserved as-is (NOTE finding N3, not in
  scope for this cycle). Switched to `SEVERITY_COLORS[f.severity]`
  indexing instead of the local `severityColor()` function — same colour.
- `dashboard/src/components/TaskArbitrationSection.tsx` (new): houses
  `TaskArbitrationSection`, `ArbitrationRunBlock`, and now uses the shared
  `FindingHighlightLink` in place of the inline `FindingIdLink`.
- `dashboard/src/pages/TaskDetailPage.tsx` (modified): 733 → 288 lines.
  Header / metadata block retained verbatim; the FSM strip, arbitration,
  and reviews sections delegate to the new components.
- `dashboard/src/pages/FindingsPage.tsx` (modified): three sidebar panels
  now open with `QueryPanel`; inline `severityColor()` helper deleted in
  favour of `SEVERITY_COLORS[r.severity]`; inline cross-route `<Link>`s
  replaced with `FindingHighlightLink` / `TaskHighlightLink`. Two of three
  `@typescript-eslint/no-explicit-any` disables removed.

## Design Decisions

- `FailureReasonsPanel` is always populated (the page pads to the full
  enum), so I pass `isEmpty={false}` to `QueryPanel` with an empty
  `emptyText`. The empty branch is unreachable by construction. Adding the
  prop pair keeps `QueryPanel`'s signature uniform across panels rather
  than inventing a second wrapper for the no-empty case.
- Kept the `severityColor()` helper exported from `finding-styling.ts`
  even though both pages migrated to direct `SEVERITY_COLORS[...]`
  indexing. Future callers can use either spelling; the helper is one
  line.
- `FindingHighlightLink` accepts an optional `severity` prop so the
  NOTE-pattern example link (which sets `severity: 'NOTE'` on the next
  search) and the contradiction-resolution link (which preserves whatever
  severity is current) share one component. Without the optional prop the
  arbitration callers would have had to spread the param themselves and
  defeat the consolidation.

## Build & Test Results

- `cd dashboard && npm run build` — pass (tsc + vite both succeed).
- `cd dashboard && npm run lint` — 10 errors, all pre-existing in
  `AgentDetailPage.tsx`, `TaskDuration.tsx`, `TeamCard.tsx`,
  `ProjectContext.tsx`, `useAutoScrollPreference.tsx`, `useChatMessages.ts`,
  `useMessages.ts`, `usePollInterval.tsx`. Phase 8 owned files are clean.
  Verified by stashing my diff, running lint (same 10 errors), then
  unstashing.
- `cd dashboard && npm test` — 151 passed, 5 files, no regressions.

## Open Questions / Risks

- The `'BLOCKING' | 'NOTE'` literal still appears at the `severity`
  segmented-control in `FindingsPage` (lines 142 cast to that union).
  Migrating that cast to `Severity` is a behaviour-neutral micro-change
  but the cast point is in a Mantine `onChange` callback whose param is
  typed as `string`, so the cast is unavoidable until that union expands.
  Leaving as-is.

## Suggested Follow-ups

- N2 / N3 from the review (FindingsPage hook extraction, CycleBlock
  "store previous prop" reshape) were marked as not-in-scope for this
  cycle.
- The pre-existing 10 lint errors in unrelated files (mostly
  `react-hooks/preserve-manual-memoization` from React Compiler) deserve
  their own pass.
