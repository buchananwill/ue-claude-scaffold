import { Group, Text } from '@mantine/core';
import { IconChevronUp, IconChevronDown, IconSelector } from '@tabler/icons-react';
import type { SortColumn } from '../hooks/useTaskFilters.ts';

interface SortHeaderProps {
  label: string;
  column: NonNullable<SortColumn>;
  activeColumn: SortColumn;
  dir: 'asc' | 'desc';
  onSort: (col: NonNullable<SortColumn>) => void;
}

export function SortHeader({
  label,
  column,
  activeColumn,
  dir,
  onSort,
}: SortHeaderProps) {
  const isActive = activeColumn === column;
  let icon = <IconSelector size={14} />;
  if (isActive && dir === 'asc') icon = <IconChevronUp size={14} />;
  if (isActive && dir === 'desc') icon = <IconChevronDown size={14} />;

  return (
    <Group
      gap={2}
      onClick={() => onSort(column)}
      style={{ cursor: 'pointer', userSelect: 'none', display: 'inline-flex' }}
    >
      <Text size="sm" fw={500}>{label}</Text>
      {icon}
    </Group>
  );
}
