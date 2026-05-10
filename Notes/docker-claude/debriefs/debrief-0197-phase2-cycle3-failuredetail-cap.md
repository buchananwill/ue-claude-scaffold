# Debrief 0197 — Phase 2 cycle 3: cap failureDetail length

## Task Summary
Address the single remaining safety reviewer WARNING (W1) on the Phase 2 server FSM
transition endpoint: `payload.failureDetail` was accepted as a free-form string and
written into `tasks.failure_detail` (Postgres `text`) with no length cap. The cycle-2
sweep had already capped `commitSha`, `latestReviewPath`, and `reviewerRole`;
`failureDetail` should follow the same pattern.

## Changes Made
- `server/src/routes/tasks-lifecycle.ts` — declared `const FAILURE_DETAIL_MAX = 4096;`
  alongside the other cap constants. Added a length check after the existing
  `typeof payload.failureDetail !== 'string'` guard that returns
  `reply.badRequest('payload.failureDetail exceeds maximum length of 4096 characters')`,
  matching the wording style of the sibling cap rejections.
- `server/src/routes/tasks-lifecycle.test.ts` — added a new test
  "any → failed returns 400 when failureDetail exceeds length cap". It drives a task
  through `claimed → engineering`, then attempts `to: 'failed'` with
  `failureReason: 'engineer_build_failure'` and a 4097-character `failureDetail`,
  asserting HTTP 400. Placed adjacent to the other length-cap tests in the same
  block.

## Design Decisions
- Kept the cap at 4096 to mirror `LATEST_REVIEW_PATH_MAX` — both are user-supplied
  free-form strings flowing into a `text` column, so a uniform ceiling is the
  least-surprising choice.
- Used `engineering → failed` for the new test rather than `claimed → failed` only
  because the surrounding tests already exercise the latter; covering an additional
  legal source state gives the cap test marginal extra value at no cost.

## Build & Test Results
Pending — will run `npm run build` in `server/` and
`npx tsx --test src/routes/tasks-lifecycle.test.ts` after committing this debrief.

## Open Questions / Risks
None. The change is a strict additive validation tightening that follows an
established pattern in the same handler.

## Suggested Follow-ups
None for this finding. Other free-form text columns elsewhere in the schema may
warrant a similar audit, but that is out of scope for Phase 2.
