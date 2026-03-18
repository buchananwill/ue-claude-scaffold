import {
  Table,
  SegmentedControl,
  Button,
  Collapse,
  Text,
  Code,
  Stack,
  Group,
} from '@mantine/core';
import { Fragment, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiPost } from '../api/client.ts';
import { notifications } from '@mantine/notifications';
import type { Task } from '../api/types.ts';
import { StatusBadge } from './StatusBadge.tsx';
import { RelativeTime } from './RelativeTime.tsx';

const filters = [
  { label: 'All', value: '' },
  { label: 'Pending', value: 'pending' },
  { label: 'Claimed', value: 'claimed' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed', value: 'completed' },
  { label: 'Failed', value: 'failed' },
];

interface TasksPanelProps {
  tasks: Task[] | null;
  isFetching: boolean;
  statusFilter: string;
  onFilterChange: (f: string) => void;
}

export function TasksPanel({ tasks, isFetching, statusFilter, onFilterChange }: TasksPanelProps) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const handleRelease = async (id: number) => {
    try {
      await apiPost(`/tasks/${id}/release`);
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
      notifications.show({ title: 'Released', message: `Task #${id} returned to pending`, color: 'green' });
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : String(err), color: 'red' });
    }
  };

  return (
    <Stack gap="sm">
      <SegmentedControl
        size="xs"
        data={filters}
        value={statusFilter}
        onChange={onFilterChange}
      />

      {(!tasks || tasks.length === 0) ? (
        <Text c="dimmed" ta="center" py="md" size="sm">No tasks</Text>
      ) : (
        <Table striped highlightOnHover fz="sm" style={{ opacity: isFetching ? 0.7 : 1, transition: 'opacity 150ms' }}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={40}>#</Table.Th>
              <Table.Th w={40}>Pri</Table.Th>
              <Table.Th w={100}>Status</Table.Th>
              <Table.Th>Title</Table.Th>
              <Table.Th>Agent</Table.Th>
              <Table.Th>Created</Table.Th>
              <Table.Th w={80} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {tasks.map((t) => (
              <Fragment key={t.id}>
                <Table.Tr
                  onClick={() => setExpanded(expanded === t.id ? null : t.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <Table.Td>{t.id}</Table.Td>
                  <Table.Td>{t.priority}</Table.Td>
                  <Table.Td><StatusBadge value={t.status} /></Table.Td>
                  <Table.Td fw={500}>{t.title}</Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">{t.claimedBy ?? '—'}</Text>
                  </Table.Td>
                  <Table.Td><RelativeTime date={t.createdAt} /></Table.Td>
                  <Table.Td>
                    {(t.status === 'claimed' || t.status === 'in_progress') && (
                      <Button
                        size="compact-xs"
                        variant="light"
                        color="orange"
                        onClick={(e) => { e.stopPropagation(); handleRelease(t.id); }}
                      >
                        Release
                      </Button>
                    )}
                  </Table.Td>
                </Table.Tr>
                {expanded === t.id && (
                  <Table.Tr>
                    <Table.Td colSpan={7}>
                      <Collapse in={expanded === t.id}>
                        <Stack gap="xs" p="sm">
                          {t.description && (
                            <div>
                              <Text size="xs" fw={600} c="dimmed">Description</Text>
                              <Text size="sm">{t.description}</Text>
                            </div>
                          )}
                          {t.acceptanceCriteria && (
                            <div>
                              <Text size="xs" fw={600} c="dimmed">Acceptance Criteria</Text>
                              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{t.acceptanceCriteria}</Text>
                            </div>
                          )}
                          {t.progressLog && (
                            <div>
                              <Text size="xs" fw={600} c="dimmed">Progress Log</Text>
                              <Code block>{t.progressLog}</Code>
                            </div>
                          )}
                          {t.result != null && (
                            <div>
                              <Text size="xs" fw={600} c="dimmed">Result</Text>
                              <Code block>{JSON.stringify(t.result, null, 2)}</Code>
                            </div>
                          )}
                          <Group gap="xs">
                            {t.claimedAt && (
                              <Text size="xs" c="dimmed">Claimed: <RelativeTime date={t.claimedAt} /></Text>
                            )}
                            {t.completedAt && (
                              <Text size="xs" c="dimmed">Completed: <RelativeTime date={t.completedAt} /></Text>
                            )}
                          </Group>
                        </Stack>
                      </Collapse>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Fragment>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
