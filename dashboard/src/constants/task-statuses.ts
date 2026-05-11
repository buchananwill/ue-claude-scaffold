/**
 * Single source of truth for task status values and their display labels.
 * Derived from STATUS_LABELS keys so there is only one place to update.
 *
 * Must match server/src/queries/tasks-core.ts VALID_TASK_STATUSES and the
 * tasks_status_check CHECK constraint declared in server/src/schema/tables.ts.
 *
 * The legacy 'in_progress' and 'completed' values are intentionally absent —
 * the new FSM (Plan: Durable Task FSM and Parallel Role Sessions) replaces
 * them with the engineering/built/reviewing/revising/arbitrating/complete
 * sequence.
 */
export const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  claimed: 'Claimed',
  engineering: 'Engineering',
  built: 'Built',
  reviewing: 'Reviewing',
  revising: 'Revising',
  arbitrating: 'Arbitrating',
  complete: 'Complete',
  failed: 'Failed',
  integrated: 'Integrated',
  cycle: 'Cycle',
};

/**
 * Mantine badge colour per task status. Exposed so any component that wants
 * to colour a task status can reuse the same mapping rather than maintaining
 * its own.
 */
export const STATUS_COLORS: Record<string, string> = {
  pending: 'gray',
  claimed: 'yellow',
  engineering: 'yellow',
  built: 'blue',
  reviewing: 'violet',
  revising: 'orange',
  arbitrating: 'pink',
  complete: 'green',
  failed: 'red',
  integrated: 'teal',
  cycle: 'gray',
};

/** Typed tuple of all task statuses, derived from STATUS_LABELS keys. */
export const TASK_STATUSES = Object.keys(STATUS_LABELS);
