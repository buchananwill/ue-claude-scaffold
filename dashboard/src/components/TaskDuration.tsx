import { useState, useEffect } from 'react';
import { Text } from '@mantine/core';

interface TaskDurationProps {
  claimedAt: string | null;
  completedAt: string | null;
  status: string;
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  if (ms < 60000) return '<1m';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function parseTs(ts: string): Date {
  return new Date(ts.endsWith('Z') ? ts : ts + 'Z');
}

const TERMINAL = new Set(['completed', 'failed', 'integrated']);
const ACTIVE = new Set(['claimed', 'in_progress']);

export function TaskDuration({ claimedAt, completedAt, status }: TaskDurationProps) {
  const [tick, setTick] = useState(0);

  const isActive = ACTIVE.has(status);

  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setTick((t) => t + 1), 10000);
    return () => clearInterval(id);
  }, [isActive]);

  // Suppress unused-var lint: tick is read to trigger re-render
  void tick;

  if (!claimedAt) return <Text span size="sm" ff="monospace">{'\u2014'}</Text>;

  let delta: number;

  if (TERMINAL.has(status)) {
    // integrated/completed/failed without completedAt: no end timestamp to compute against, show dash
    if (!completedAt) return <Text span size="sm" ff="monospace">{'\u2014'}</Text>;
    delta = parseTs(completedAt).getTime() - parseTs(claimedAt).getTime();
  } else if (isActive) {
    delta = Date.now() - parseTs(claimedAt).getTime();
  } else {
    return <Text span size="sm" ff="monospace">{'\u2014'}</Text>;
  }

  if (isNaN(delta)) return <Text span size="sm" ff="monospace">{'\u2014'}</Text>;

  return <Text span size="sm" ff="monospace">{formatDuration(delta)}</Text>;
}
