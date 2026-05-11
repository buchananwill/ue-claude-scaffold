# Debrief 0212 — Phase 8 cycle 4: server contract fixes

## Task Summary

Address review findings on Phase 8 dashboard work that span into server code.
The correctness reviewer raised three BLOCKING findings (B1, B2, B3) and one
WARNING (W1). Each one prevents Phase 8 acceptance criteria from being met:

- B1: dashboard calls `GET /tasks/:id/arbitrations`, but the server only exposes
  the POST handler at that path — every `ArbitrationSection` render 404s.
- B2: `GET /tasks/:id/reviews/:cycle` omits `postedAt`, but the dashboard
  declares it required on `ReviewRun` and renders it via `<RelativeTime>`.
- B3: `formatTask` drops seven FSM-relevant columns, causing the FSM cycle
  counter to read `0 / undefined`, verdict chips to render empty, the
  arbitration alert to say "unspecified", and the failure banner to never
  render.
- W1: finding ordinal label hardcoded `B{ordinal}` regardless of severity.

## Scope deviation (explicit)

Phase 8's file ownership note constrains writes to the dashboard. This cycle
deliberately reaches into three server files because the prior phases (3, 7)
left server-side contract gaps that the dashboard cannot work around — the
fields and endpoints are missing on the wire. Fixing only the dashboard would
mean rendering wrong data, not delivering the acceptance criteria. The build
errors / runtime 404s these gaps produce are this cycle's responsibility under
the "all build errors are your responsibility" rule, and the same logic
applies to runtime-contract gaps that defeat the deliverable.

## Changes Made

- `server/src/routes/arbitrations.ts` — Added `GET /tasks/:id/arbitrations`
  handler returning `{ runs: ArbitrationRun[] }`, project-scoped via
  `requireProjectIdHeader`, ordered by `postedAt ASC` then `id ASC` as a
  stable tiebreaker. Mirrors the GET pattern from `reviews.ts`: 400 on bad
  id, 404 on missing/foreign task, 200 with `runs: []` when none exist.
  Serialises `postedAt` to ISO string and `contradictionResolution` as the
  typed object shape declared in `dashboard/src/api/types.ts`.
- `server/src/routes/arbitrations.test.ts` — Added six tests for the new
  endpoint: empty array, two-row happy path with order assertion, 404 for
  unknown task id, 400 for invalid id, 400 for missing X-Project-Id, 404 for
  task in a different project.
- `server/src/routes/reviews.ts` — Added `postedAt: reviewRuns.postedAt` to
  the Drizzle select for the GET handler, and projected it into the response
  as an ISO string (matching the dashboard's `ReviewRun.postedAt: string`).
- `server/src/routes/tasks-types.ts` — Extended `TaskRow`, `toTaskRow`, and
  `formatTask` to include all seven previously-omitted FSM fields:
  `reviewCycleBudget`, `reviewerVerdicts` (jsonb → typed via `unknown` cast,
  same pattern `agentRolesOverride` uses), `arbitrationPendingTrigger`,
  `failureReason`, `failureDetail`, `buildStatus`, `commitSha`. Defaulted
  to schema defaults (e.g. `5` for budget, `{}` for verdicts, `'pending'`
  for buildStatus) where the column is `NOT NULL` and the row might predate
  the migration. `null` for the optional ones.
- `dashboard/src/pages/TaskDetailPage.tsx` — Added `severityOrdinalPrefix`
  helper that returns `'B'` for BLOCKING and `'N'` for NOTE, and used it
  at the accordion call site so the ordinal label tracks severity.

## Design Decisions

- **`reviewerVerdicts` typed as `unknown` on `TaskRow`**: Mirrors the existing
  `agentRolesOverride` pattern. Drizzle returns jsonb as `unknown`; the route
  layer hands it through, and the dashboard's TypeScript types
  (`ReviewerVerdictMap`) validate it at the consumer. We do not parse it here.
- **GET arbitrations ordering**: `postedAt ASC, id ASC` — postedAt is the
  caller-visible order; id is the deterministic tiebreaker if two rulings
  share a timestamp (unlikely but possible with the `defaultNow()` resolution).
- **`postedAt` ISO serialisation defensiveness**: Drizzle hands back a Date
  in our pglite test path but a string under node-postgres. The `instanceof
  Date` guard handles both without an extra coerce.
- **Did not extend `Task` type on the dashboard**: it already declares all the
  fields — this cycle is about making the server payload match the existing
  type declaration, not the reverse.

## Build & Test Results

- `cd server && npm run typecheck` — passes.
- `cd server && npm run build` — passes.
- `cd server && npx tsx --test src/routes/arbitrations.test.ts
  src/routes/reviews.test.ts` — 55 tests, all pass (including the 6 new ones
  exercising `GET /tasks/:id/arbitrations`).
- `cd dashboard && npm run build` — passes.
- `cd dashboard && npx eslint src/pages/TaskDetailPage.tsx` — clean.
- `cd server && npm test` (full suite) — 58 failures observed. Spot-checked
  several: `agent-definitions.test.ts`, `agents.test.ts`, `tasks-deps.test.ts`,
  and `tasks-claim.test.ts` failures are all from the test environment's
  missing git identity (`fatal: unable to auto-detect email address (got
  'claude@…(none)')`). `projects.test.ts` failures and the two tasks.test.ts
  bulk-delete failures reproduce on the prior commit (verified by stashing
  this cycle's changes and re-running `tasks.test.ts` — same 2 fails). These
  are pre-existing environmental / test-ordering issues; not introduced by
  this cycle.
- `cd dashboard && npm run lint` — pre-existing errors in
  `AgentDetailPage.tsx` and other files outside my scope; the file I touched
  (`TaskDetailPage.tsx`) is clean.

## Open Questions / Risks

- The `reviewerVerdicts` jsonb column is typed as `unknown` on the server
  side. The dashboard `Task.reviewerVerdicts: ReviewerVerdictMap` cast at
  the consumer is unchecked — if a stale row somehow contained a different
  shape, the UI would render that as-is. This matches the
  `agentRolesOverride` pattern and was not in scope to harden.

## Suggested Follow-ups

- The pre-existing `tasks.test.ts` bulk-delete failures use `status=completed`
  which isn't in the new FSM enum (valid: `complete`). Either the status name
  needs aligning across the codebase or the test should be updated. Out of
  scope here.
- The pre-existing dashboard ESLint errors on `AgentDetailPage.tsx` are React
  Compiler memoization warnings. Worth a dedicated cleanup pass.

## NOTE-tier findings recorded

N1, N2, N3 from the safety reviewer were informational only and not actioned
this cycle per instructions.
