# Debrief 0209 — Phase 8: Dashboard rendering of FSM and review tables

## Task Summary

Implement Phase 8 of the durable-task-fsm-and-parallel-role-sessions plan: extend the dashboard to render the new task FSM state, parallel-reviewer verdict strip, per-cycle review runs, arbitration rulings, and the cross-task `/findings` view (BLOCKING list, NOTE patterns, arbitration patterns, failure-reason patterns).

## Changes Made

- `dashboard/src/constants/task-statuses.ts` — replace legacy status set. Dropped `in_progress` and `completed`; added `engineering`, `built`, `reviewing`, `revising`, `arbitrating`, `complete`. Added `STATUS_COLORS` map (single source of truth for badge colors per status) and exported it so `StatusBadge` uses scaffold-wide statuses rather than its private color map.
- `dashboard/src/api/types.ts` — extend `Task` with new FSM columns (`reviewCycleCount`, `reviewCycleBudget`, `reviewerVerdicts`, `latestReviewPath`, `arbitrationPendingTrigger`, `arbitrationAddendumPath`, `failureReason`, `failureDetail`, `agentRolesOverride`, `buildStatus`, `commitSha`). Added `AgentRoles`, `ReviewerVerdict`, `ReviewerVerdictMap`, `ReviewFinding`, `ReviewRun`, `ReviewCycleResponse`, `ArbitrationRun`, `Finding` (list-row shape), `FindingsResponse`, `NotePattern`, `NotePatternsResponse`, `ArbitrationPattern`, `ArbitrationPatternsResponse`, `FailureReasonPattern`, `FailureReasonsResponse`, and the `FailureReason` enum tuple/type.
- `dashboard/src/api/client.ts` — add typed helpers `fetchReviewCycle`, `fetchTaskArbitrations`, `fetchFindings`, `fetchNotePatterns`, `fetchArbitrationPatterns`, `fetchFailureReasons` that delegate to `apiFetch`. Query-string building is done with `URLSearchParams` so a `since` ISO date never gets double-encoded.
- `dashboard/src/pages/TaskDetailPage.tsx` — major rewrite:
  - FSM strip card: status badge, `Cycle N / M` counter, per-reviewer verdict chips, failure-reason banner when status is `failed`, arbitration-pending placeholder when status is `arbitrating`.
  - "Reviews" section: lists each cycle (descending), and for each cycle the per-reviewer runs with `MarkdownContent`-rendered review markdown and an expandable `<Accordion>` of structured findings (severity badge, file:line, title; expand for description / evidence / fix).
  - "Arbitration" section: lists each `arbitrationRuns` row with trigger, ruling, timestamp, markdown-rendered ruling, and (for `ruling='rule'`) the contradiction-resolution callout with upheld/retired finding IDs and rationale.
- `dashboard/src/pages/FindingsPage.tsx` (new) — `/findings` route. Four panels:
  1. **BLOCKING-recent**: paginated list driven by URL search params `severity` (`BLOCKING|NOTE`), `reviewer`, `since`.
  2. **NOTE patterns**: top-20 NOTE titles by occurrence in last 30 days; click expands to example finding IDs (server returns up to 3 per pattern).
  3. **Arbitration patterns**: counts grouped by `(trigger, ruling)` in last 30 days.
  4. **Failure-reason patterns**: counts of `tasks.failure_reason` over last 30 days, padded client-side to render all six enum values; `role_session_no_op` is visually emphasised with a red warning badge when its count is non-zero (per Phase 8 work item 7).
- `dashboard/src/router.tsx` — register the `/findings` route under `projectRoute` with `validateSearch` for `severity`, `reviewer`, `since`. `VALID_TASK_STATUSES` is derived from the regenerated `TASK_STATUSES`; legacy callers passing `?status=in_progress` are silently filtered (consistent with existing behaviour). Added a `findingsRoute` nav entry would require touching DashboardLayout (out of scope per file ownership); the route is reachable via direct URL and via per-task links in the new task-detail view.

## Design Decisions

- **`StatusBadge` color map vs. `STATUS_COLORS`.** `StatusBadge.tsx` already had its own color map but it was stale (still listed `in_progress`/`completed`, missing all the new FSM statuses). It's outside my file-ownership scope, so I cannot edit it — but I owned `task-statuses.ts`. I exported `STATUS_COLORS` from `task-statuses.ts` to establish the single source of truth; the existing badge will silently fall back to `gray` for the new statuses. Flagged as a follow-up — a one-line change to `StatusBadge.tsx` to consult `STATUS_COLORS` first would fix it.
- **No new nav entry.** Adding a `Findings` link to the left nav requires editing `DashboardLayout.tsx`, which is outside scope. The `/findings` route is reachable directly and via task-detail links. Flagged as a follow-up.
- **Markdown renderer.** Reused `MarkdownContent` everywhere review/ruling markdown is rendered — no second renderer introduced.
- **Reviewer-verdict chip click-through.** The plan calls for "Clicking a reviewer chip with a `request_changes` verdict expands the rendered markdown and the structured findings table." Implemented by scrolling-and-opening the corresponding `Accordion` item in the Reviews section via a controlled-value `value` prop on the cycle accordion; chips are buttons that set the accordion value.
- **Pagination on `/findings`.** Server contract gives `total` and supports `offset`. Implemented a `Pagination` control with a hard `limit=50` (matches server max-200 cap and the plan's example `limit=50`).
- **`since` default.** Server defaults `since` to `now() - 30d`; the dashboard sends no `since` unless the URL has one, so the trailing-30-day window is honoured.
- **`router.tsx` style sweep.** The `as any` cast on the `Link` `search` prop in `TaskDetailPage` was already in the file (pre-existing limitation of TanStack Router cross-route Links); left as-is.
- **Type for `reviewerVerdicts` JSONB.** Modelled as `Partial<Record<string, ReviewerVerdict>>` because the keys are arbitrary reviewer-role slugs determined per-project by `projects.agentRoles.reviewers`. The task-detail page iterates `Object.entries(task.reviewerVerdicts ?? {})` so an empty/null map degrades gracefully.

## Build & Test Results

- `npm run build` in `/workspace/dashboard` — **PASS** (`tsc -b && vite build`, 7792 modules transformed; vite bundle warning about chunk size is unchanged pre-existing noise).
- `npm test` — **PASS** (5 test files, 151 tests).
- `npm run lint` — **10 errors remaining, all pre-existing in files outside my file-ownership** (`TaskDuration.tsx`, `TeamCard.tsx`, `ProjectContext.tsx`, `useAutoScrollPreference.tsx`, `useChatMessages.ts`, `useMessages.ts`, `usePollInterval.tsx`, `AgentDetailPage.tsx`). No new lint errors introduced in any of my owned files.
- Build iteration history:
  1. First build failed: `buildQuery`'s `Record<string, string | number | undefined>` signature did not accept the typed `FindingsQuery`/`NotePatternsQuery`/`ArbitrationsQuery`/`FailureReasonsQuery` interfaces because TS interfaces lack index signatures. Fixed by relaxing the parameter type to `object` and iterating `Object.entries`.
  2. First build failed: `useTaskFilters.test.ts` `makeTask` factory needed the new required `Task` fields. Fixed by adding defaults in the test factory (out-of-scope edit, justified under "build errors are your responsibility"; minimum viable fix).
  3. After lint, briefly retyped `prev: any` to `Record<string, unknown>` in the back-link's `search` callback. TS rejected it because TanStack Router demands the route's literal search-shape. Reverted to `(prev: any)` with an inline eslint-disable-next-line comment.

## Open Questions / Risks

- `StatusBadge.tsx` is outside my file-ownership scope but its color map is now out of date with the new FSM statuses. I left it alone; a follow-up agent should update it to consume `STATUS_COLORS` from `task-statuses.ts`.
- `DashboardLayout.tsx` is outside scope; the `/findings` page has no nav-bar entry until that file is edited.
- The plan's acceptance criterion "clicking a `request_changes` reviewer chip expands the markdown and findings table" presumes the cycle in question is the current one. My implementation opens the Accordion for the cycle matching `task.reviewCycleCount` (the active cycle). Older `request_changes` runs from earlier cycles are visible by scrolling/expanding manually.

## Suggested Follow-ups

- Update `dashboard/src/components/StatusBadge.tsx` to consume `STATUS_COLORS` from `task-statuses.ts` so the new FSM statuses get correct colours.
- Add a `Findings` entry to `DashboardLayout.tsx`'s `NAV_ITEMS` (icon: `IconAlertTriangle` or similar).
- Once Phase 3 `GET /tasks/:id/arbitrations` endpoint shape is finalised, double-check the `ArbitrationRun[]` payload assumption (this implementation assumes `{ runs: ArbitrationRun[] }`).
