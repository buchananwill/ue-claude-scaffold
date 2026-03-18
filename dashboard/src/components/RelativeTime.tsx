import { Text } from '@mantine/core';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

interface RelativeTimeProps {
  date: string | null;
  fallback?: string;
}

export function RelativeTime({ date, fallback = '—' }: RelativeTimeProps) {
  if (!date) return <Text span c="dimmed" size="sm">{fallback}</Text>;

  const d = date.endsWith('Z') ? dayjs(date) : dayjs(date + 'Z');
  return (
    <Text span c="dimmed" size="sm" title={d.toDate().toLocaleString()}>
      {d.fromNow()}
    </Text>
  );
}
