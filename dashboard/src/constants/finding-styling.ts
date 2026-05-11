/**
 * Shared styling tokens for review findings, reviewer verdicts, and severity
 * badges. Centralises the colour maps and severity-derived helpers so that
 * TaskDetailPage, FindingsPage, and any sub-components built on top of them
 * pull from a single source of truth.
 *
 * Why a constants module rather than inline literals at each call site:
 *   - The severity literal `'BLOCKING' | 'NOTE'` was hand-written at ~10
 *     sites despite being the `severity` field on `ReviewFinding`. Re-using
 *     the schema type via the `Severity` alias keeps callers honest as the
 *     enum grows.
 *   - `severityColor()` and `VERDICT_COLORS` were both duplicated in
 *     TaskDetailPage and FindingsPage. Moving them here is a pure refactor
 *     that lets both pages share the same palette.
 */
import type { ReviewFinding, ReviewerVerdict } from '../api/types.ts';

/** Alias re-export so callers can spell `Severity` instead of the literal union. */
export type Severity = ReviewFinding['severity'];

/**
 * Mantine colour for each finding severity. Index this map directly rather
 * than calling a helper when you already have the severity in hand.
 */
export const SEVERITY_COLORS: Record<Severity, string> = {
  BLOCKING: 'red',
  NOTE: 'gray',
};

/** Convenience helper preserved for sites that previously called `severityColor()`. */
export function severityColor(severity: Severity): string {
  return SEVERITY_COLORS[severity];
}

/**
 * Mantine colour for each reviewer verdict, used by the FSM strip chips and
 * the per-cycle accordion controls.
 */
export const VERDICT_COLORS: Record<ReviewerVerdict, string> = {
  pending: 'gray',
  approve: 'green',
  request_changes: 'red',
  out_of_scope: 'blue',
};
