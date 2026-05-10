/**
 * Returns the first element of a query result array, or throws if empty.
 * Used after `.returning()` inserts where zero rows indicates an unexpected state.
 */
export function firstOrThrow<T>(rows: T[]): T {
  if (rows.length === 0) throw new Error('Insert returned no rows');
  return rows[0];
}

/**
 * Task statuses that represent actively-held work — claimed or running through
 * any FSM mid-state. Single source of truth for both the legacy DELETE guards
 * (used by `tasks-core.deleteById`, `routes/tasks.ts`) and the lifecycle WHERE
 * clauses (used by `release`, `updateProgress`, `releaseByAgent`,
 * `releaseAllActive`, and the coalesce queries). Mirrors the FSM portion of
 * the schema CHECK at server/src/schema/tables.ts (tasks_status_check).
 *
 * The legacy `'in_progress'` value is intentionally absent — it was removed
 * from the schema CHECK at the FSM cutover; any consumer attempting to write
 * it would fail at the DB layer regardless.
 */
export const ACTIVE_STATUSES = [
  'claimed',
  'engineering',
  'built',
  'reviewing',
  'revising',
  'arbitrating',
] as const;

/** Set form of `ACTIVE_STATUSES` for callers that need O(1) membership tests
 *  (e.g. route guards that check a single status value). */
export const ACTIVE_STATUSES_SET: ReadonlySet<string> = new Set(ACTIVE_STATUSES);

/** Task statuses that represent terminal (finished) work. */
export const TERMINAL_STATUSES = ['completed', 'failed', 'cycle'] as const;

/** Agent statuses that represent inactive agents (not actively working). */
export const INACTIVE_AGENT_STATUSES = ['stopping', 'done', 'error', 'paused'] as const;
