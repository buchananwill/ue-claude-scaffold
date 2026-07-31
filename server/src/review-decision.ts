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
 *
 * FINAL-CYCLE RELAXATION. Predicates 2 and 3 are volume predicates: they read a
 * pile of non-blocking notes as evidence that the work is not yet clean. That
 * inference stops being useful on the last cycle of the budget, where the only
 * alternative to acceptance is arbitration — a task that has been thoroughly
 * nit-picked across every prior cycle should not be dragged before an
 * arbitrator because the reviewers are still bikeshedding. So on the final
 * cycle (see `isFinalReviewCycle`) predicates 2 and 3 are dropped and only the
 * blocking signals survive: an explicit `request_changes` verdict (predicate 1)
 * and any BLOCKING finding (predicate 4). Non-blocking findings raised on the
 * final cycle no longer force a revision.
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

export interface ClassifyReviewOptions {
  /**
   * True when the cycle being classified is the last one the budget allows —
   * a `revise` verdict here reroutes to arbitration instead of buying another
   * engineering revolution. Drops the finding-volume predicates (2 and 3).
   * Derive it with `isFinalReviewCycle`; never hand-compute the comparison.
   */
  isFinalCycle?: boolean;
}

/**
 * Is `reviewCycleCount` the last cycle the budget allows?
 *
 * The cycle-budget reroute in the `reviewing → revising` gate increments first
 * and then checks (`count + 1 > budget` → arbitrating), so the cycle from which
 * a revision would reroute to arbitration is exactly `count >= budget`. This
 * helper is the single definition of "final cycle" shared by the accept gate,
 * the revise gate, and the container's mirror of the same decision.
 */
export function isFinalReviewCycle(
  reviewCycleCount: number,
  reviewCycleBudget: number,
): boolean {
  return reviewCycleCount >= reviewCycleBudget;
}

export function classifyReview(
  rows: ReviewerAggregate[],
  opts: ClassifyReviewOptions = {},
): ReviewDecision {
  if (rows.length === 0) return "incomplete";

  const anyRequestChanges = rows.some((r) => r.verdict === "request_changes");
  const anyBlocking = rows.some((r) => r.blockingCount >= 1);

  // Blocking signals fire on every cycle, final or not.
  if (anyRequestChanges || anyBlocking) return "revise";

  // Volume predicates — dropped on the final cycle so that a pile of
  // non-blocking notes cannot push a clean-enough task into arbitration.
  if (!opts.isFinalCycle) {
    const anyFourPlusFindings = rows.some((r) => r.findingsCount >= 4);
    const reviewersWithMultipleFindings = rows.filter(
      (r) => r.findingsCount >= 2,
    ).length;

    if (anyFourPlusFindings || reviewersWithMultipleFindings >= 2) {
      return "revise";
    }
  }

  return "accept";
}
