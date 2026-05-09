---

# Phase 3 — Server review ingestion, per-task fetch, and cross-task aggregation endpoints

Part of [Plan: Durable Task FSM and Parallel Role Sessions](./_index.md). See the index for the shared goal and context — this phase body assumes them.

**Files:**
- `server/src/routes/reviews.ts` (new)
- `server/src/routes/reviews.test.ts` (new)
- `server/src/routes/findings.ts` (new) — cross-task BLOCKING-list and NOTE-pattern aggregation
- `server/src/routes/findings.test.ts` (new)
- `server/src/routes/failures.ts` (new) — `failure_reason`-grouped count aggregation for the Phase 8 Failure-reasons panel
- `server/src/routes/failures.test.ts` (new)
- `server/src/routes/index.ts` (register the three new modules)

**Work:**
1. `POST /tasks/:id/reviews` body:
   ```
   {
     "cycle": number,
     "reviewerRole": string,
     "verdict": "approve" | "request_changes" | "out_of_scope",
     "rawMarkdown": string,
     "findings": [
       {
         "severity": "BLOCKING" | "NOTE",
         "ordinal": number,
         "filePath"?: string,
         "line"?: number,
         "title": string,
         "description": string,
         "evidence"?: string,
         "fix"?: string
       }
     ]
   }
   ```
   In a single transaction:
   - Insert one row into `reviewRuns` with the supplied fields.
   - Insert N rows into `reviewFindings` referencing the new run.
   - Return `{ runId, findingIds: [...] }`.
   - On unique constraint conflict (already-posted run for `(taskId, cycle, reviewerRole)`), return 409 — the caller is duplicating; client must dedupe.
2. `GET /tasks/:id/reviews/:cycle` returns the per-run breakdown for that cycle:
   ```
   {
     "cycle": number,
     "runs": [
       { "reviewerRole", "verdict", "rawMarkdown", "findings": [...] }
     ]
   }
   ```
   Empty `runs` array if the cycle has no posted runs yet.
3. `GET /findings` — cross-task BLOCKING-recent list, project-scoped via `X-Project-Id`. Query params: `severity` (default `'BLOCKING'`, also accepts `'NOTE'`), `reviewer` (filter by reviewer-role slug, optional), `since` (ISO date, default now-30d), `limit` (default 50, max 200), `offset` (default 0). Returns:
   ```
   {
     "findings": [
       {
         "id": int, "taskId": int, "cycle": int, "reviewerRole": string,
         "severity": "BLOCKING" | "NOTE",
         "filePath": string|null, "line": int|null,
         "title": string, "postedAt": timestamp
       }
     ],
     "total": int
   }
   ```
   Joined query: `review_findings INNER JOIN review_runs ON review_runs.id = review_findings.run_id WHERE review_runs.task_id IN (project's tasks) AND severity = ? AND review_runs.posted_at >= ?`. Default sort by `postedAt DESC`.

4. `GET /findings/note-patterns` — aggregated NOTE-tier `title`-grouped counts, project-scoped. Query params: `since` (ISO date, default now-30d), `limit` (default 20, max 50). Returns:
   ```
   {
     "patterns": [
       { "title": string, "count": int, "exampleFindingIds": [int, int, int] }
     ]
   }
   ```
   Query: `SELECT title, COUNT(*) as count, ARRAY_AGG(id ORDER BY posted_at DESC LIMIT 3) as example_finding_ids FROM review_findings JOIN review_runs ON ... WHERE severity = 'NOTE' AND posted_at >= ? GROUP BY title ORDER BY count DESC LIMIT ?`. Project-scoping is applied by joining `tasks` and filtering on `tasks.project_id`.

5. `GET /arbitrations` — aggregated arbitration counts grouped by `(trigger, ruling)`, project-scoped. Query params: `since` (ISO date, default now-30d). Returns:
   ```
   {
     "patterns": [
       { "trigger": string, "ruling": string, "count": int, "exampleTaskIds": [int, int, int] }
     ]
   }
   ```
   Same shape as note-patterns but grouping on `(trigger, ruling)` and project-scoped via the `tasks` join.

6. `GET /failures/reasons` — aggregated counts of `tasks.failure_reason` for rows where `status = 'failed'`, project-scoped. Query params: `since` (ISO date, default now-30d). Returns:
   ```
   {
     "patterns": [
       { "failureReason": string, "count": int, "exampleTaskIds": [int, int, int] }
     ]
   }
   ```
   Query: `SELECT failure_reason, COUNT(*) as count, ARRAY_AGG(id ORDER BY completed_at DESC LIMIT 3) as example_task_ids FROM tasks WHERE project_id = ? AND status = 'failed' AND failure_reason IS NOT NULL AND completed_at >= ? GROUP BY failure_reason ORDER BY count DESC`. The response includes one entry per `failure_reason` value that has at least one row in the window — the dashboard pads zero-count entries client-side so all six enum values render in the panel.

7. `X-Project-Id` header required on all six endpoints. The cross-task endpoints (`/findings`, `/findings/note-patterns`, `/arbitrations`, `/failures/reasons`) scope all results to the requesting project — no cross-project leakage.

**Acceptance criteria:**
- `POST /tasks/:id/reviews` inserts the run plus N findings atomically; either both land or neither does.
- `POST /tasks/:id/reviews` with `findings: []` is allowed (an `approve` or `out_of_scope` verdict need not carry findings) and returns `{ runId, findingIds: [] }`. An `approve` verdict MAY also carry NOTE findings; the count is unconstrained.
- Reposting the same `(taskId, cycle, reviewerRole)` returns 409.
- `GET /tasks/:id/reviews/:cycle` on a cycle with three runs returns three entries in the `runs` array.
- `GET /findings?severity=BLOCKING&reviewer=safety&since=2026-04-01` returns matching rows project-scoped, sorted by `postedAt DESC`, paginated.
- `GET /findings/note-patterns` returns NOTE-tier titles grouped by exact-match count, top-N descending.
- `GET /arbitrations` returns arbitration counts grouped by `(trigger, ruling)` over the trailing 30 days.
- `GET /failures/reasons` returns counts grouped by `failure_reason` for `status='failed'` rows over the trailing 30 days, with example task IDs per reason. A row with `failure_reason='role_session_no_op'` is included if any such failure occurred in the window.
- All cross-task endpoints reject requests missing `X-Project-Id` with 400.
- All cross-task endpoints scope to the requesting project — a finding from project A never appears in project B's results, even if `taskId` collides.
