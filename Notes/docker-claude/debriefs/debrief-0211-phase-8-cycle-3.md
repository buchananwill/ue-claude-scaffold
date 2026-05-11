# Phase 8 cycle 3 — NOTE-pattern highlight link fix

## Task Summary

Address a single BLOCKING correctness finding from cycle 3 review:

**B1** — In `dashboard/src/pages/FindingsPage.tsx`, the NOTE-pattern example
finding ID link built a `/findings?highlight=<id>` search object that did not
inject `severity`. Because the page defaults `severity` to `'BLOCKING'` when
absent, navigating to a NOTE-tier finding from the pattern list landed the
operator on a BLOCKING-only query — the target row was never in the result set
and the highlight never fired.

## Changes Made

- `dashboard/src/pages/FindingsPage.tsx` — in `PatternList`'s `exampleKind === 'finding'`
  branch, updated the `Link` `search` callback to inject `severity: 'NOTE'`
  alongside `highlight`. `'NOTE'` is already a member of
  `VALID_FINDING_SEVERITIES` in `router.tsx`, so no router-side change was needed.
  The `exampleKind === 'task'` (arbitration) branch is unaffected.

## Design Decisions

- The pattern list endpoint that surfaces these example IDs is
  `GET /findings/note-patterns`, which by definition only returns NOTE-tier
  findings. Hard-coding `severity: 'NOTE'` in this single link site is therefore
  correct — there is no callsite ambiguity.
- Kept the `...prev` spread first so that any other search keys the operator had
  set are preserved; `severity` and `highlight` then override.

## Build & Test Results

- `cd dashboard && npm run build` — pass.
- `cd dashboard && npm test` — pass.

## Open Questions / Risks

None.

## Suggested Follow-ups

None.
