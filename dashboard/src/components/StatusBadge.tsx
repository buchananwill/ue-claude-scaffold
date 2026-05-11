import { Badge } from '@mantine/core';
import { STATUS_COLORS } from '../constants/task-statuses.js';

/**
 * Color map for non-task statuses (agents, message types, team statuses).
 * Task-status colours come from `STATUS_COLORS` in `constants/task-statuses.ts`
 * — that file is the single source of truth for the FSM status palette, so the
 * badge component reads it directly rather than maintaining a duplicate.
 */
const otherColorMap: Record<string, string> = {
  // agent statuses
  idle: 'gray',
  working: 'yellow',
  building: 'blue',
  testing: 'violet',
  done: 'green',
  stopping: 'orange',
  error: 'red',
  // message types
  info: 'blue',
  build_queued: 'orange',
  build_started: 'yellow',
  build_complete: 'green',
  build_failed: 'red',
  test_queued: 'orange',
  test_started: 'yellow',
  test_complete: 'green',
  test_failed: 'red',
  progress: 'cyan',
  // team statuses
  active: 'green',
  converging: 'yellow',
  dissolved: 'gray',
};

interface StatusBadgeProps {
  value: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
}

export function StatusBadge({ value, size = 'sm' }: StatusBadgeProps) {
  const color = STATUS_COLORS[value] ?? otherColorMap[value] ?? 'gray';
  return (
    <Badge color={color} variant="light" size={size}>
      {value}
    </Badge>
  );
}
