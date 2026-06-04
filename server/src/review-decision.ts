/**
 * Findings-based accept/revise decision for a review cycle.
 *
 * The FSM no longer trusts reviewer verdicts alone to decide whether a task is
 * accepted or sent back for revision. A reviewer may APPROVE while still
 * surfacing a pile of findings, or two reviewers may each raise one finding —
 * both signal that the work is not yet clean. This module folds the per-cycle
 * review-run rows (verdict + finding tallies) into a single verdict.
 *
 * The decision is computed identically here (server-authoritative, gating the
 * `reviewing → completed` / `reviewing → revising` transitions) and in the
 * container's `reviewer-fanout.sh` (which chooses which transition to POST).
 * Both read the same `review_runs` / `review_findings` rows, so they agree.
 *
 * Predicates that force a revision round (ANY one fires):
 *   1. Any reviewer returned `request_changes`.
 *   2. Any reviewer raised >= 4 findings (BLOCKING + NOTE both count).
 *   3. >= 2 reviewers each raised at least two findings.
 *   4. Any reviewer raised a BLOCKING finding (a reviewer should have
 *      requested changes in this case — predicate 4 is the backstop for when
 *      they did not).
 *
 * Acceptance is the exact complement (for a non-empty review set): fewer than
 * two reviewers with two-or-more findings, at most three findings on any single
 * reviewer, no BLOCKING findings, and every reviewer verdict in
 * {approve, out_of_scope}. `out_of_scope` counts as clear — a reviewer whose
 * domain does not apply to the task must not block acceptance forever.
 */

export interface ReviewerAggregate {
  reviewerRole: string;
  /** 'approve' | 'request_changes' | 'out_of_scope' */
  verdict: string;
  /** Total findings (BLOCKING + NOTE) this reviewer raised this cycle. */
  findingsCount: number;
  /** Subset of findingsCount with severity BLOCKING. */
  blockingCount: number;
}

/**
 * - `accept`     — the review meets every acceptance conjunct.
 * - `revise`     — at least one revision predicate fired.
 * - `incomplete` — no reviewer rows for the cycle; the caller must not treat
 *                  this as either accept or revise (mirrors the old
 *                  "empty verdicts → cannot complete" guard).
 */
export type ReviewDecision = "accept" | "revise" | "incomplete";

export function classifyReview(rows: ReviewerAggregate[]): ReviewDecision {
  if (rows.length === 0) return "incomplete";

  const anyRequestChanges = rows.some((r) => r.verdict === "request_changes");
  const anyFourPlusFindings = rows.some((r) => r.findingsCount >= 4);
  const reviewersWithMultipleFindings = rows.filter(
    (r) => r.findingsCount >= 2,
  ).length;
  const anyBlocking = rows.some((r) => r.blockingCount >= 1);

  if (
    anyRequestChanges ||
    anyFourPlusFindings ||
    reviewersWithMultipleFindings >= 2 ||
    anyBlocking
  ) {
    return "revise";
  }

  return "accept";
}
