# Debrief 0115 — Phase 1 Audit Accuracy Fixes (Cycle 2)

## Task Summary

Fix five review findings (2 blocking, 3 warnings) in `plans/schema-hardening-v25/audit-scratch.md` — mislabeled function names, an out-of-spec section, missing SQL safety analysis, missing dependency rationale, and incomplete scope description.

## Changes Made

- **`plans/schema-hardening-v25/audit-scratch.md`** — All fixes applied:
  - B1: Corrected line 71 label from "complete task" to "release task" and line 89 from "fail task" to "reset task". Added note that `complete()` and `fail()` preserve `claimedBy`.
  - B2: Removed `messages.claimedBy` from section 7 (was 10th section, not a spec target). Renumbered sections 8-10 to 7-9. Moved `messages.claimedBy` content to Appendix A with clear "not a migration target" label.
  - W1: Added safety note to `tasks-claim.ts:21` and `:61-62` entries confirming they use Drizzle's `sql` tagged template (auto-parameterised, no injection risk).
  - W2: Added Appendix B explaining uuid v7 is needed for time-ordered UUIDs with B-tree index locality; `crypto.randomUUID()` only does v4 random UUIDs and is insufficient.
  - W3: Added status-filter detail to `releaseByAgent` (WHERE claimedBy=agent AND status IN claimed/in_progress) and `releaseAllActive` (WHERE status IN claimed/in_progress only).

## Design Decisions

- Chose appendix approach for `messages.claimedBy` rather than deletion — preserves the audit work for reference while clearly demarcating it as non-spec.
- Kept appendix B (uuid rationale) in the audit file rather than a separate document since it directly justifies a Phase 1 dependency choice.

## Build & Test Results

- `npm run typecheck` from `server/`: clean pass (no errors). This phase only modifies a markdown audit file so no runtime impact.

## Open Questions / Risks

None.

## Suggested Follow-ups

None.
