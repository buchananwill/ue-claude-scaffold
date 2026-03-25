import { Badge } from '@mantine/core';

const colorMap: Record<string, string> = {
  // agent statuses
  idle: 'gray',
  working: 'yellow',
  building: 'blue',
  testing: 'violet',
  done: 'green',
  stopping: 'orange',
  error: 'red',
  // task statuses
  pending: 'gray',
  claimed: 'yellow',
  in_progress: 'blue',
  completed: 'green',
  failed: 'red',
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
  const color = colorMap[value] ?? 'gray';
  return (
    <Badge color={color} variant="light" size={size}>
      {value}
    </Badge>
  );
}
