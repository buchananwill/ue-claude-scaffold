/**
 * Single source of truth for task status values and their display labels.
 * Derived from STATUS_LABELS keys so there is only one place to update.
 *
 * Must match server/src/queries/tasks-core.ts VALID_TASK_STATUSES
 */
export const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  claimed: 'Claimed',
  in_progress: 'In Progress',
  completed: 'Completed',
  failed: 'Failed',
  integrated: 'Integrated',
  cycle: 'Cycle',
};

/** Typed tuple of all task statuses, derived from STATUS_LABELS keys. */
export const TASK_STATUSES = Object.keys(STATUS_LABELS) as ReadonlyArray<string>;
