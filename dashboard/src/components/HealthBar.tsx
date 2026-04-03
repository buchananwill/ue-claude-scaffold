import type { ReactNode } from 'react';
import { Anchor, Group, Text, SegmentedControl, Indicator } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import type { HealthResponse } from '../api/types.js';
import { useProject } from '../contexts/ProjectContext.tsx';

interface HealthBarProps {
  health: HealthResponse | null;
  error: string | null;
  intervalMs: number;
  onIntervalChange: (ms: number) => void;
  middle?: ReactNode;
}

const intervals = [
  { label: '2s', value: '2000' },
  { label: '5s', value: '5000' },
  { label: '10s', value: '10000' },
];

export function HealthBar({ health, error, intervalMs, onIntervalChange, middle }: HealthBarProps) {
  const connected = !error && !!health;
  const { projectName } = useProject();

  return (
    <Group h="100%" px="md" justify="space-between">
      <Group gap="sm">
        <Indicator color={connected ? 'green' : 'red'} size={10} processing={connected}>
          <div />
        </Indicator>
        <Anchor component={Link} to="/" underline="never" c="inherit">
          <Text fw={700} size="lg">{projectName}</Text>
        </Anchor>
        {error && (
          <Text c="red" size="sm">Disconnected</Text>
        )}
      </Group>
      {middle}
      <Group gap="sm">
        <Text size="xs" c="dimmed">Poll:</Text>
        <SegmentedControl
          size="xs"
          data={intervals}
          value={String(intervalMs)}
          onChange={(v) => onIntervalChange(Number(v))}
        />
      </Group>
    </Group>
  );
}
