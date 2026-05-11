# Debrief 0210 — Phase 8 cycle 2 (dashboard FSM rendering fixes)

## Task Summary

Address review findings raised on commit `51a3237` (Phase 8 implementation of
the durable-task-fsm-and-parallel-role-sessions plan). Two parallel reviewers
identified three BLOCKING correctness defects, two WARNING correctness items,
and one WARNING safety item. Fix all of them in a single iteration, rebuild,
recommit.

## Changes Made

- **`dashboard/src/pages/TaskDetailPage.tsx`** — B1: converted `CycleBlock`'s
  Mantine `Accordion` from uncontrolled (`defaultValue`) to controlled (`value`
  + `onChange`). Operator chip-clicks now reliably open the matching reviewer
  panel after mount, and previously-opened panels are preserved when the
  pinned reviewer changes (union semantics, not replace). Used the
  "store-previous-prop during render" pattern (`useState` for `lastPinned`,
  comparison + setState before return) to satisfy the
  `react-hooks/set-state-in-effect` lint rule. B2: introduced a
  `FindingIdLink` helper component that renders upheld/retired finding IDs as
  clickable links into `/findings?highlight=<id>`; threaded `projectId` into
  `ArbitrationRunBlock` so the Link can build the correct route.
- **`dashboard/src/pages/FindingsPage.tsx`** — B3: parsed the new `highlight`
  search param, plumbed `highlightFindingId` into `FindingsTable`, and gave
  matching rows a yellow background (`var(--mantine-color-yellow-1)`).
  Extended `PatternList` to accept `projectId` and an `exampleKind` discriminator
  (`finding` | `task`); NOTE-pattern example finding IDs render as Links to
  `/findings?highlight=<id>`, arbitration-pattern example task IDs render as
  Links to `/tasks/<id>`.
- **`dashboard/src/router.tsx`** — registered `highlight` on the `findingsRoute`
  `validateSearch` callback (positive integer up to 1B). W1-s: replaced the
  permissive `Number(search.page) > 0` validators on both `overviewRoute` and
  `findingsRoute` with `Number.isInteger(n) && n > 0 && n <= 100_000`, blocking
  scientific-notation / Infinity inputs from producing `?offset=Infinity`.
- **`dashboard/src/components/StatusBadge.tsx`** — W1-c: dropped the inline
  legacy task-status entries and read from `STATUS_COLORS` (the
  `constants/task-statuses.ts` source of truth). The remaining inline map now
  only covers non-task statuses (agent statuses, message types, team
  statuses). New FSM statuses (`engineering`, `built`, `reviewing`, `revising`,
  `arbitrating`, `complete`) now render in their intended colours wherever
  `StatusBadge` is used.
- **`dashboard/src/hooks/useTaskFilters.test.ts`** — W2-c: replaced six
  occurrences each of the dropped `'completed'` and `'in_progress'` status
  strings with `'complete'` and `'engineering'` respectively. Adjusted the
  sort-by-status assertion to reflect alphabetical ordering of the new
  literals.

## Design Decisions

**B2 / B3 click-through target.** The plan calls for click-through "to each
finding's full content." The server's `GET /findings/note-patterns` response
shape returns only finding IDs (no task ID, no cycle), so the direct
`GET /tasks/:id/reviews/:cycle` route is not reachable from the dashboard with
just an ID. I rejected extending the server response because the plan's file
list scopes this task to dashboard files only (and `StatusBadge.tsx` is the
explicitly-authorised exception). The chosen dashboard-only approach links to
`/findings?highlight=<id>`, which:

- works for any ID returned by `note-patterns` (the same query that surfaced
  the example IDs feeds the BLOCKING/NOTE table, so the row is reachable);
- visually emphasises the matching row when it is on the current page (yellow
  background);
- if the ID is not on the current page, the operator still lands on the
  queryable findings table and can filter to it via the existing severity /
  reviewer / since controls.

This is a moderate deviation from the plan's literal "fetches full rows via
`GET /tasks/:id/reviews/:cycle`" wording — the click-through reaches the row
in the findings list rather than the cycle's full review markdown. The
trade-off is documented here and was explicitly authorised by the reviewer's
B3 guidance ("Prefer the simpler dashboard-only fix unless the server already
returns enough context"). Same approach was reused for B2's upheld/retired
finding IDs in arbitration rulings, for consistency.

**B1 setState-in-render pattern.** The first attempt used `useEffect` with
`setState`, which triggered the project's `react-hooks/set-state-in-effect`
lint rule. Switched to React's official "store the previous prop value" pattern
(compare `pinnedReviewer` to a `lastPinnedReviewer` state, update both during
render). This computes the merged open-items synchronously without a cascading
render.

**W1-c color source of truth.** Rather than copying `STATUS_COLORS` entries
into `StatusBadge`'s map, I made the badge import from
`constants/task-statuses.ts` directly. The lookup falls back to the non-task
inline map for agent/message/team statuses. This keeps task-status colour
ownership in one file.

## Build & Test Results

- `npm run build` (dashboard): clean, no TypeScript errors.
- `npm test` (dashboard): 5 files / 151 tests, all pass.
- `npm run lint` (dashboard): 10 errors, all pre-existing on baseline
  (verified by `git stash` + lint before reverting). No new lint errors
  introduced by this round.

## Open Questions / Risks

- The `/findings?highlight=<id>` click-through visibly flags a row only when
  it is in the currently-loaded page. If the operator paginates away, the
  highlight persists in the URL but no row matches. This is acceptable
  behaviour given the constraint, but a future iteration could either (a)
  extend the server to support `id IN (…)` filtering on `GET /findings`, or
  (b) extend `note-patterns` to return `(findingId, taskId, cycle)` triples so
  the dashboard can route directly to the task's cycle.
- The B1 fix uses the "set state during render comparing previous prop"
  pattern. It is correct per React docs, but slightly less common than
  `useEffect`. The lint rule that drove this choice
  (`react-hooks/set-state-in-effect`) is project policy.

## Suggested Follow-ups

- Extend `GET /findings/note-patterns` server response to include `taskId` and
  `cycle` alongside `exampleFindingIds`, enabling true `tasks/:id/reviews/:cycle`
  navigation per the plan's literal wording. This is a single-route change in
  `server/src/routes/findings.ts` and a parallel update to the dashboard `Link`
  target.
- Lint baseline cleanup (10 pre-existing errors across
  `AgentDetailPage.tsx`, `TaskDuration.tsx`, `TeamCard.tsx`, the contexts and
  hooks). Out of scope for this phase but worth a dedicated cleanup task.
