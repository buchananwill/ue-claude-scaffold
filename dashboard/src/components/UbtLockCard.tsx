import { Card, Text, Badge, List, Group, Stack, ThemeIcon } from '@mantine/core';
import { IconLock, IconLockOpen } from '@tabler/icons-react';
import type { UbtStatus } from '../api/types';
import { RelativeTime } from './RelativeTime';

interface UbtLockCardProps {
  status: UbtStatus | null;
}

export function UbtLockCard({ status }: UbtLockCardProps) {
  if (!status) {
    return (
      <Card withBorder p="sm">
        <Text c="dimmed" size="sm">Loading UBT status...</Text>
      </Card>
    );
  }

  const isFree = !status.holder;

  return (
    <Card withBorder p="sm">
      <Stack gap="xs">
        <Group gap="xs">
          <ThemeIcon
            variant="light"
            color={isFree ? 'green' : 'orange'}
            size="sm"
          >
            {isFree ? <IconLockOpen size={14} /> : <IconLock size={14} />}
          </ThemeIcon>
          <Text fw={600} size="sm">UBT Lock</Text>
        </Group>

        {isFree ? (
          <Text c="green" size="sm">UBT is free</Text>
        ) : (
          <Group gap="xs">
            <Badge color="orange" variant="light" size="sm">{status.holder}</Badge>
            <RelativeTime date={status.acquiredAt} />
            {status.stale && <Badge color="red" variant="light" size="xs">STALE</Badge>}
          </Group>
        )}

        {status.queue.length > 0 && (
          <div>
            <Text size="xs" c="dimmed" fw={600} mb={4}>Queue</Text>
            <List size="sm" type="ordered">
              {status.queue.map((q) => (
                <List.Item key={q.id}>
                  <Group gap={4}>
                    <Text size="sm">{q.agent}</Text>
                    <Text size="xs" c="dimmed">(pri: {q.priority})</Text>
                  </Group>
                </List.Item>
              ))}
            </List>
          </div>
        )}

        {!isFree && status.estimatedWaitMs > 0 && (
          <Text size="xs" c="dimmed">
            Est. wait: {Math.round(status.estimatedWaitMs / 1000)}s
          </Text>
        )}
      </Stack>
    </Card>
  );
}
