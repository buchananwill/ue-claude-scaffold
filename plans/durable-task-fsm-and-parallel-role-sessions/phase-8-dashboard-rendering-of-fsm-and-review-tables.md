---

# Phase 8 — Dashboard rendering of FSM and review tables

Part of [Plan: Durable Task FSM and Parallel Role Sessions](./_index.md). See the index for the shared goal and context — this phase body assumes them.

**Files:**
- `dashboard/src/pages/TaskDetailPage.tsx` — extend with FSM state, per-reviewer chips, Reviews tab, and Arbitration section
- `dashboard/src/pages/FindingsPage.tsx` (new) — global Findings, NOTE patterns, and arbitration patterns view
- `dashboard/src/api/client.ts` — add functions for the Phase 3 review endpoints and the Phase 7 arbitration endpoint
- `dashboard/src/api/types.ts` — extend the task type with the new fields (`reviewCycleCount`, `reviewCycleBudget`, `reviewerVerdicts`, `latestReviewPath`, `arbitrationPendingTrigger`, `arbitrationAddendumPath`, `failureReason`, `failureDetail`, `agentRolesOverride`); add `ReviewRun`, `ReviewFinding`, `ArbitrationRun`, `AgentRoles` types
- `dashboard/src/router.tsx` — register the `/findings` route under `projectRoute`, with `validateSearch` for `severity`, `reviewer`, and `since` filters
- `dashboard/src/constants/task-statuses.ts` — replace the legacy status set with the new one. The file exports `STATUS_LABELS` (the source of truth) and `TASK_STATUSES` (derived from `Object.keys(STATUS_LABELS)`). Drop the `'in_progress'` and `'completed'` keys from `STATUS_LABELS` (the new schema rejects those values). Keep `'pending'`, `'claimed'`, `'failed'`, `'integrated'`, `'cycle'` (unchanged carry-overs). Add `'engineering'`, `'built'`, `'reviewing'`, `'revising'`, `'arbitrating'`, `'complete'` with display labels and badge/color entries (suggested: engineering = amber, built = blue, reviewing = purple, revising = orange, arbitrating = magenta, complete = green). The local `VALID_TASK_STATUSES` Set inside `dashboard/src/router.tsx` is built from `TASK_STATUSES` and updates automatically; verify the router file's `validateSearch` callbacks compile against the new set.

**Work:**
1. Extend the task-detail view to show the FSM state explicitly: a status badge for current state, a cycle counter (`Cycle 2 / 5`), and a per-reviewer verdict strip (one chip per declared reviewer with state ∈ {pending, approve, request_changes, out_of_scope}). Read `reviewerVerdicts` jsonb directly.
2. Add a "Reviews" tab on the task detail. For each `(cycle, reviewerRole)` in `review_runs`:
   - Show the verdict and posted-at timestamp.
   - Render `rawMarkdown` (use the existing markdown renderer the dashboard already has for messages).
   - Below the markdown, show a structured table of findings (severity, file:line, title) sourced from `review_findings`. Click-through expands to description, evidence, fix.
3. Add a global "Findings" view at `/findings` listing the most recent BLOCKING findings across all tasks for the current project. Calls `GET /findings?severity=BLOCKING&reviewer=<role>&since=<date>&limit=50` (Phase 3). Filters bound to the URL search-params via `router.tsx`'s `validateSearch`. This is the queryable view that justifies the structured rows.
4. Add a "NOTE patterns" panel on the same view: calls `GET /findings/note-patterns?since=<date>&limit=20` (Phase 3). Aggregated NOTE-tier titles ranked by occurrence over the last 30 days. NOTEs are observability-only by design — the operator scans this panel to spot recurring patterns that warrant escalating into a system-prompt rule, a skill amendment, or a new reviewer mandate. Clicking an entry expands to the constituent findings (the endpoint returns up to 3 example finding IDs per pattern; click-through fetches full rows via `GET /tasks/:id/reviews/:cycle`).
5. **Arbitration rendering on the task-detail page.** When a task has rows in `arbitrationRuns`, render an "Arbitration" section per row showing: the trigger, the ruling, the ruling markdown (markdown-rendered), the timestamp, and (for `ruling='rule'`) the upheld vs. retired finding IDs with click-through to each finding's full content. A task at `arbitrating` state shows a pending placeholder until the arbitrator posts.
6. **Arbitration patterns panel.** On `/findings`, add a third panel alongside BLOCKING-recent and NOTE-patterns: calls `GET /arbitrations?since=<date>` (Phase 3). Aggregated counts grouped by `(trigger, ruling)` over the last 30 days. This is the operator's signal that one or both arbitrable failure modes are firing more than expected — a high `(review_cycle_budget_exhausted, escalate)` count means the cycle budget needs raising or reviewer prompts need tightening; a high `(reviewer_contradiction, *)` count means two reviewer mandates are systematically clashing.

7. **Failure-reasons panel.** On `/findings`, add a fourth panel that aggregates `tasks.failure_reason` counts for `status='failed'` rows over the trailing 30 days, grouped by `failure_reason`, sorted by count descending. This requires a new server endpoint `GET /failures/reasons?since=<date>` returning `{ patterns: [{ failureReason, count, exampleTaskIds }] }` (parallel shape to `/findings/note-patterns` and `/arbitrations`); add this to Phase 3's file list and acceptance criteria as a follow-on. The panel renders all six enum values (`review_cycle_budget_exhausted`, `reviewer_contradiction`, `engineer_build_failure`, `reviewer_infrastructure_failure`, `role_session_no_op`, `arbitrator_escalated`) with counts; entries with count > 0 are emphasized. **`role_session_no_op` is specifically flagged for operator attention** (e.g. red badge or warning icon) because under the new design it is the only path where a clean Claude exit can terminally fail a task without surfacing through the abnormal-exit circuit breaker — the panel is the operator's only routine signal that this failure mode is firing.

8. The existing message-board view continues to read from `messages` unchanged. **Reviewer findings are no longer relayed through `messages`** in the new flow (Phase 6 has reviewers POST directly to `/reviews`); update the dashboard's task-detail page so it reads review state from `review_runs`, not from message-board scraping.

**Acceptance criteria:**
- The task-detail page on a `reviewing`-state task shows three reviewer chips, the current cycle, and the cycle budget.
- Clicking a reviewer chip with a `request_changes` verdict expands the rendered markdown and the structured findings table.
- The `/findings` view returns a paginated list of BLOCKING findings sorted by `posted_at` desc.
- A query like `findings?severity=BLOCKING&reviewer=safety&since=2026-04-01` returns only matching rows.
- The NOTE patterns panel renders the top 20 `title`-grouped NOTEs by occurrence count over the trailing 30 days; clicking a row expands to the constituent finding rows.
- A task with an `arbitrationRuns` row shows the "Arbitration" section with the rendered ruling markdown and (for contradictions) the upheld/retired finding callout.
- The arbitration patterns panel renders aggregated counts by `(trigger, ruling)` over the trailing 30 days.
- The Failure-reasons panel renders aggregated `tasks.failure_reason` counts for `status='failed'` rows over the trailing 30 days, with all six enum values listed and `role_session_no_op` visually flagged when its count is non-zero.
